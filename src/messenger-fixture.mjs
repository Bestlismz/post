export function createMessengerFixture(store) {
  return {
    async sendText(payload) {
      return store.mutate((state) => { state.fixtureMessengerSends ??= []; const value = { ...payload, state: "sent", messageId: `fixture_${state.fixtureMessengerSends.length + 1}`, sentAt: new Date().toISOString() }; state.fixtureMessengerSends.push(value); return value; });
    },
  };
}
