export class AssertError extends Error {
  constructor(msgId) {
    super(msgId);
    this.msgId = msgId;
  }
}

export function assert(cond, msgId = 'assert-fail') {
  if (!cond) {
    throw new AssertError(msgId);
  }
}

export function assertNot(cond, msgId = 'assert-fail') {
  if (cond) {
    throw new AssertError(msgId);
  }
}

export function unreachable(msgId = 'unreachable') {
  throw new AssertError(msgId);
}

export function randomUnder(upper) {
  return Math.floor(Math.random() * upper);
}

const idChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ./';
export function randomId(len) {
  return Array.from(Array(len), () => idChars[randomUnder(idChars.length)]).join('');
}

export function vaildId(str, len) {
  return ((str.length <= len) && ([...str].every(c => idChars.includes(c))));
}

export function delay(time) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, time);
  });
}

export class TimeoutError extends Error {
  constructor(waitedTime) {
    super();
    this.waitedTime = waitedTime;
  }
}

export function timeout(time) {
  return delay(time).then(() => Promise.reject(new TimeoutError(time)));
}

export class CancelPromiseError extends Error {
  constructor(name, value) {
    super('canceled');
    this.name = name;
  }
}

function cancelablePromise(name) {
  return new Promise((resolve, reject) => {
    window.addEventListener(name, ev => {
      if ((ev.detail != undefined) && (ev.detail != null)) {
        resolve(ev.detail);
      } else {
        reject(new CancelPromiseError(name));
      }
    }, { once: true });
  });
}

function cancelPromiseByName(name) {
  const fire = new CustomEvent(name);
  window.dispatchEvent(fire);
}

function resolvePromiseByName(name, value) {
  const fire = new CustomEvent(name,  { detail: value });
  window.dispatchEvent(fire);
}

export const NamedPromise = {
  CancelPromiseError,
  create: cancelablePromise,
  cancel: cancelPromiseByName,
  resolve: resolvePromiseByName,
};

export function itemAt(array, n) {
	// ToInteger() abstract op
	n = Math.trunc(n) || 0;
	// Allow negative indexing from the end
	if(n < 0) n += array.length;
	// OOB access is guaranteed to return undefined
	if(n < 0 || n >= array.length) return undefined;
	// Otherwise, this is just normal property access
	return array[n];
}
