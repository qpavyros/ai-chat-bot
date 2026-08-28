const test = require("node:test");
const assert = require("node:assert/strict");
const conversation = require("../../src/services/conversation");
const handoff = require("../../src/services/handoff");

test("إيقاف وإعادة تفعيل البوت لزبون شخصي (Live Takeover)", () => {
  const clientId = "test-client-takeover";
  const userId = "user-1234";

  assert.equal(conversation.isPaused(clientId, userId), false);

  handoff.pauseBotUser(clientId, userId, 2);
  assert.equal(conversation.isPaused(clientId, userId), true);

  const paused = handoff.getPausedConversations(clientId);
  assert.equal(paused.length, 1);
  assert.equal(paused[0].endUserId, userId);

  handoff.resumeBotUser(clientId, userId);
  assert.equal(conversation.isPaused(clientId, userId), false);
  assert.equal(handoff.getPausedConversations(clientId).length, 0);
});
