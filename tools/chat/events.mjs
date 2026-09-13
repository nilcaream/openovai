// What the server tells the page as it happens: a row appended, a question parked or answered,
// a seat's process started or gone, a quota reading, the instance stopping.
//
// One list of subscribers and one `publish`. The modules that know when something happened call
// `publish` where it happens — conversation.mjs at the append, permissions.mjs at the park and
// the answer, lifecycle.mjs at the spawn and the close — and server.mjs writes every event to
// the streams it holds open. Nothing is kept: a page that missed events asks for what it missed
// when it connects again, with the counts it has, so there is no buffer to size and nothing to
// replay twice.

const subscribers = new Set();

// Called with every event from now on; answers what stops it.
export function subscribe(listener) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function publish(name, data) {
  const event = { name, data };
  for (const listener of subscribers) {
    listener(event);
  }
  return event;
}
