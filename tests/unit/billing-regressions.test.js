const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FIXED_TIME = new Date("2026-09-02T12:00:00Z").getTime();
const normalize = (obj) => obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));

function createHarness(initialVfs = null) {
  const vfs = initialVfs ? new Map(initialVfs) : new Map();
  const clientLocks = new Map();
  const MockDate = class extends Date {
    constructor(...args) { if (args.length === 0) super(FIXED_TIME); else super(...args); }
    static now() { return FIXED_TIME; }
  };

  const config = {
    plans: { starter: { price: 20 }, growth: { price: 50 }, pro: { price: 100 } },
    referral: { rewardMonths: 1 },
    topUpPacks: { small: { credits: 1000, priceUsd: 10 }, medium: { credits: 3000, priceUsd: 25 } },
    admin: { sessionTtlHours: 1 },
    provisioning: { publicBaseUrl: 'http://localhost' },
    deepseek: { priceInPerMillion: 1, priceOutPerMillion: 1 }
  };

  const stubs = {
    "../config": config,
    "./config": config,
    "path": path,
    "crypto": require("crypto"),
    "fs": {
      existsSync: (p) => {
         if (p.includes('knowledge.md') || p.includes('config.json') || p.includes('.json')) {
           const k = p.split(/[\\/]+clients[\\/]+/).pop().replace(/\\/g, '/');
           return vfs.has(k) || Array.from(vfs.keys()).some(fk => fk.startsWith(k + '/'));
         }
         return false;
      },
      readFileSync: (p, enc) => {
         const k = p.split(/[\\/]+clients[\\/]+/).pop().replace(/\\/g, '/');
         if (vfs.has(k)) return vfs.get(k);
         throw new Error("ENOENT: " + p);
      },
      writeFileSync: () => {},
      readdirSync: () => [],
      statSync: () => ({size: 0, mtime: new Date(FIXED_TIME)})
    },
    "express": {
      Router: () => {
        const r = { routes: {} };
        r.get = (p, ...h) => r.routes[`GET ${p}`] = h;
        r.post = (p, ...h) => r.routes[`POST ${p}`] = h;
        r.put = (p, ...h) => r.routes[`PUT ${p}`] = h;
        return r;
      },
      json: () => (req, res, next) => next()
    }
  };

  stubs["../middleware/sessionCookies"] = { parseCookies: ()=>({}), setSessionCookie: ()=>{}, clearSessionCookie: ()=>{}, clientIp: ()=>'' };
  stubs["../services/adminAuth"] = { validateSession: ()=>true, isLocked: ()=>false, checkPassword: ()=>true, recordFailure: ()=>{}, recordSuccess: ()=>{}, createSession: ()=>'', destroySession: ()=>{} };
  stubs["../services/auditLog"] = { record: ()=>{} };
  stubs["../services/replyCache"] = { clear: ()=>{} };
  stubs["../services/provisioning"] = { generateUniqueSlug: (n)=>n };
  stubs["../services/apiKeys"] = { generatePublicKey: ()=>'pk_test' };
  stubs["../services/escalationLog"] = { readRecent: ()=>[] };
  stubs["../services/escalationHandled"] = { getHandledIds: ()=>[], markHandled: ()=>{}, unmarkHandled: ()=>{} };
  stubs["../services/orders"] = { readOrders: ()=>[] };
  stubs["../services/appointments"] = { readAppointments: ()=>[] };
  stubs["../services/stats"] = { snapshot: ()=>({}) };
  stubs["../clients/registry"] = { getClientById: (id) => vfs.has(`${id}/config.json`) ? { id } : null };
  stubs["../services/customers"] = { getProfile: ()=>({}), saveTurn: ()=>{} };
  stubs["../services/deepseek"] = { getReply: async ()=>({text: 'mock'}) };
  stubs["../services/handoff"] = { extractEscalationMarker: (t)=>({cleanText: t}) };

  const api = { vfs, injectFailureOnce: null };

  const mockSafeWrite = {
    listClientIds: () => [...new Set(Array.from(vfs.keys()).map(k => k.split('/')[0]))],
    assertValidClientId: (id) => { if(!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid"); },
    clientDir: (id) => path.join(__dirname, '..', '..', 'src', 'clients', id),
    dataDir: (id) => `/data/${id}`,
    withClientLock: async (clientId, fn) => {
       const prev = clientLocks.get(clientId) || Promise.resolve();
       const next = prev.then(fn, fn);
       clientLocks.set(clientId, next.catch(() => {}));
       return next;
    },
    rawWriteClientFile: (clientId, fileName, content) => {
       if(api.injectFailureOnce === clientId+'/'+fileName) { api.injectFailureOnce=null; throw Error('Injected write failure'); }
       vfs.set(clientId+'/'+fileName, content);
    },
    safeReadJSON: (filePath, fallback) => {
       const k = filePath.split(/[\\/]+clients[\\/]+/).pop().replace(/\\/g, '/');
       if (vfs.has(k)) {
          try { return JSON.parse(vfs.get(k)); } catch(e) { return fallback; }
       }
       return fallback;
    },
    safeWriteJSON: async (clientId, fileName, dataObject, opts) => {
       return mockSafeWrite.withClientLock(clientId, () => {
         const key = `${clientId}/${fileName}`;
         if (api.injectFailureOnce === key) {
            api.injectFailureOnce = null;
            throw new Error("Injected write failure");
         }
         if (opts?.validate) {
           const err = opts.validate(dataObject);
           if (err) throw new Error(err);
         }
         vfs.set(key, JSON.stringify(dataObject, null, 2));
       });
    },
    safeWriteFile: async (clientId, fileName, content, opts) => {
       return mockSafeWrite.withClientLock(clientId, () => {
         const key = `${clientId}/${fileName}`;
         if (api.injectFailureOnce === key) {
            api.injectFailureOnce = null;
            throw new Error("Injected write failure");
         }
         if (opts?.validate) {
           const err = opts.validate(content);
           if (err) throw new Error(err);
         }
         vfs.set(key, content);
       });
    }
  };
  mockSafeWrite.updateClientConfig = (id, updater, opts={}) => mockSafeWrite.withClientLock(id, async()=>{
    const cfg=mockSafeWrite.safeReadJSON(path.join(mockSafeWrite.clientDir(id),'config.json'),null);
    if(!cfg) throw Error('Missing client');
    const next=await updater(cfg);
    if(opts.validate) { const err=opts.validate(next); if(err) throw Error(err); }
    mockSafeWrite.rawWriteClientFile(id,'config.json',JSON.stringify(next));return next;
  });
  mockSafeWrite.withClientsLock = (ids, fn) => {
    const sorted=[...new Set(ids)].sort();
    const take=i=>i===sorted.length?fn():mockSafeWrite.withClientLock(sorted[i],()=>take(i+1));return take(0);
  };
  stubs["../services/safeWrite"] = mockSafeWrite;
  stubs["./safeWrite"] = mockSafeWrite;

  const basePath = path.join(__dirname, '../../src');

  function loadRealModule(relPath) {
     const code = fs.readFileSync(path.join(basePath, relPath), 'utf8');
     const mod = { exports: {} };
     vm.runInNewContext(code, {
       module: mod,
       exports: mod.exports,
       require: (id) => { if (Object.hasOwn(stubs,id)) return stubs[id]; throw Error('Unexpected dependency: '+id); },
       console, Date: MockDate, Math, String, Object, Array, Boolean, JSON, Promise, Number, Error, Intl,
       __dirname: path.join(basePath, path.dirname(relPath))
     });
     return mod.exports;
  }

  stubs["../services/clientConfigSchema"] = loadRealModule('services/clientConfigSchema.js');
  stubs["../services/clientEligibility"] = loadRealModule('services/clientEligibility.js');
  stubs["./clientConfigSchema"] = stubs["../services/clientConfigSchema"];
  stubs["./clientEligibility"] = stubs["../services/clientEligibility"];
  stubs["../middleware/asyncHandler"] = require('../../src/middleware/asyncHandler');
  if(fs.existsSync(path.join(basePath,'services/billing.js'))) stubs['../services/billing']=stubs['./billing']=loadRealModule('services/billing.js');
  stubs["../services/credits"] = stubs["./credits"] = loadRealModule('services/credits.js');
  

  const adminMod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(basePath, 'routes/admin.js'), 'utf8'), {
    module: adminMod, exports: adminMod.exports,
    require: (id) => { if (Object.hasOwn(stubs,id)) return stubs[id]; throw Error('Unexpected dependency: '+id); },
    __dirname: path.join(basePath, 'routes'),
    console, Date: MockDate, Math, String, Object, Array, Boolean, JSON, Promise, Error, Buffer
  });
  const router = adminMod.exports;

  async function runRoute(method, routePath, req) {
     const handlers = router.routes[`${method} ${routePath}`];
     if (!handlers) throw new Error(`Route not found: ${method} ${routePath}`);
     
     let statusCode = 200;
     let responseData = null;
     const res = {
       status: (c) => { statusCode = c; return res; },
       json: (d) => { responseData = d; },
       redirect: (u) => { statusCode = 302; responseData = { redirect: u }; },
       sendFile: (f) => { responseData = { file: f }; }
     };

     req.get = name => req.headers?.[name.toLowerCase()];
     req.headers ||= {}; req.body ||= {};
     let forwarded;
     await handlers.at(-1)(req,res,e=>{forwarded=e;});
     if(forwarded) throw forwarded;
     if (statusCode >= 400) {
       const err = new Error(responseData?.error || 'HTTP Error');
       err.status = statusCode;
       throw err;
     }
     return responseData;
  }

  api.recordPayment = async (clientId, operationId, now = FIXED_TIME) => {
     return runRoute('POST', '/admin/api/clients/:id/record-payment', {
       params: { id: clientId },
       body: { operationId },
       headers: { 'idempotency-key': operationId }
     });
  };

  api.applyReferralReward = async (clientId, now = FIXED_TIME) => {
     return runRoute('POST', '/admin/api/clients/:id/apply-referral-reward', {
       params: { id: clientId }
     });
  };

  api.addCredits = async (clientId, packKey, operationId) => {
     if (!operationId) return stubs["../services/credits"].addCredits(clientId, packKey);
     return runRoute('POST', '/admin/api/clients/:id/topup', {
       params: { id: clientId },
       body: { pack: packKey, operationId },
       headers: { 'idempotency-key': operationId }
     });
  };

  api.readClient = (clientId) => JSON.parse(vfs.get(`${clientId}/config.json`));
  api.writeClient = (clientId, data) => {
     if (!data.id) data.id = clientId;
     vfs.set(`${clientId}/config.json`, JSON.stringify(data, null, 2));
  };

  return api;
}

describe('Billing Regressions', () => {
  let api;
  
  beforeEach(() => {
    api = createHarness();
  });

  it('payment converts trial and preserves precise renewed instant', async () => {
    api.writeClient('c1', {
       id: 'c1', displayName: 'C1', escalation: { contactMethod: 'a' },
       plan: 'trial', trialExpiresAt: '2026-09-10T15:30:45Z',
       status: 'active'
    });
    
    await api.recordPayment('c1', 'req1');
    const c1 = api.readClient('c1');
    
        assert.strictEqual(c1.plan, 'manual');
        assert.strictEqual(c1.trialExpiresAt, undefined);
        assert.strictEqual(c1.subscriptionExpiresAt, '2026-10-10T15:30:45.000Z');
        assert.strictEqual(c1.status, 'active');
  });

  it('same topup operation does not duplicate balance', async () => {
    api.writeClient('c2', {
       id: 'c2', displayName: 'C2', escalation: { contactMethod: 'a' },
       topUpCreditsRemaining: 0, paymentHistory: []
    });
    
    await api.addCredits('c2', 'small', 'op1');
    await api.addCredits('c2', 'small', 'op1'); 
    
    const c2 = api.readClient('c2');
        assert.strictEqual(c2.topUpCreditsRemaining, 1000);
        assert.strictEqual(c2.paymentHistory.length, 1);
  });

  it('idempotency for recordPayment replays identical result', async () => {
    
    api.writeClient('c3', {
       id: 'c3', displayName: 'C3', escalation: { contactMethod: 'a' },
       plan: 'manual', subscriptionExpiresAt: '2026-09-01T00:00:00Z', paymentHistory: []
    });
    
    const res1 = normalize(await api.recordPayment('c3', 'pay1'));
    const c3_1 = api.readClient('c3');
    
    const res2 = normalize(await api.recordPayment('c3', 'pay1'));
    const c3_2 = api.readClient('c3');
    
    assert.deepStrictEqual(res1, res2);
    assert.deepStrictEqual(c3_1, c3_2);
    assert.strictEqual(c3_2.paymentHistory.length, 1);
  });

  it('simultaneous samekey only records once, differentkeys both count', async () => {
    
    api.writeClient('c4', {
       id: 'c4', displayName: 'C4', escalation: { contactMethod: 'a' },
       plan: 'manual', subscriptionExpiresAt: '2026-09-01T00:00:00Z', paymentHistory: []
    });
    
    const [p1, p2] = await Promise.allSettled([
       api.recordPayment('c4', 'op_simul'),
       api.recordPayment('c4', 'op_simul')
    ]);
    
    const c4 = api.readClient('c4');
    assert.strictEqual(c4.paymentHistory.length, 1);
    assert.strictEqual(p1.status, 'fulfilled');
    assert.strictEqual(p2.status, 'fulfilled');
    assert.deepStrictEqual(normalize(p1.value), normalize(p2.value));
    
    await Promise.allSettled([
       api.recordPayment('c4', 'op_diff1'),
       api.recordPayment('c4', 'op_diff2')
    ]);
    
    const c4b = api.readClient('c4');
    assert.strictEqual(c4b.paymentHistory.length, 3);
  });

  it('rejects reuse of samekey with different operation', async () => {
    
    api.writeClient('c5', { id: 'c5', displayName: 'C5', escalation: { contactMethod: 'a' } });
    await api.addCredits('c5', 'small', 'op_conflict');
    
    await assert.rejects(api.addCredits('c5', 'medium', 'op_conflict'), error => error.status === 409 || error.statusCode === 409);
    await assert.rejects(api.recordPayment('c5', 'op_conflict'), error => error.status === 409 || error.statusCode === 409);
  });

  it('rejects missing or invalid idempotency key with 400', async () => {
    api.writeClient('c6', { id: 'c6', displayName: 'C6', escalation: { contactMethod: 'a' } });
    
    await assert.rejects(api.recordPayment('c6', undefined), error => error.status === 400 || error.statusCode === 400);
    await assert.rejects(api.recordPayment('c6', ''), error => error.status === 400 || error.statusCode === 400);
  });

  it('referral only counts subscription payments and handles partial failure securely', async () => {
    
    api.writeClient('c7_referrer', {
       id: 'c7_referrer', displayName: 'Ref', escalation: { contactMethod: 'a' },
       plan: 'manual', subscriptionExpiresAt: '2026-09-01T00:00:00Z', paymentHistory: []
    });
    api.writeClient('c7_referred', {
       id: 'c7_referred', displayName: 'Refd', escalation: { contactMethod: 'a' },
       referredByClientId: 'c7_referrer', referralRewarded: false,
       plan: 'manual', paymentHistory: [ { at: '2026-08-15T12:00:00Z' } ] 
    });
    
    await api.addCredits('c7_referred', 'small', 'topup1');
    await assert.rejects(api.applyReferralReward('c7_referred')); 
    
    await api.recordPayment('c7_referred', 'pay1');
    
    api.injectFailureOnce = 'c7_referred/config.json';
    await assert.rejects(api.applyReferralReward('c7_referred'));
    
    await api.applyReferralReward('c7_referred');
    
    const referrer = api.readClient('c7_referrer');
    const referred = api.readClient('c7_referred');
    
    assert.strictEqual(referred.referralRewarded, true);
    assert.strictEqual(referrer.subscriptionExpiresAt, '2026-10-02T12:00:00.000Z');
    
    await api.applyReferralReward('c7_referred');
    assert.strictEqual(api.readClient('c7_referrer').subscriptionExpiresAt, referrer.subscriptionExpiresAt);
  });

  it('idempotency survives module reload over persistent state', async () => {
    
    api.writeClient('c9', { id: 'c9', displayName: 'C9', escalation: { contactMethod: 'a' }, plan: 'manual' });
    const res1 = normalize(await api.recordPayment('c9', 'op_survive'));
    
    const api2 = createHarness(api.vfs); 
    const res2 = normalize(await api2.recordPayment('c9', 'op_survive'));
    
    assert.deepStrictEqual(res1, res2);
    const c9 = api2.readClient('c9');
    assert.strictEqual(c9.paymentHistory.length, 1);
  });
});
