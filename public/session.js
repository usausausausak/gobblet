import { Contoller } from './controller.js';
import { assert, unreachable, CancelPromiseError } from './util.js';

export class SessionManager {
  constructor(gameFactory) {
    this.gameFactory = gameFactory;
    this.myFactory = undefined;
    this.roomManagerFactory = undefined;

    // placeholder, always have a value
    this.placeholder = { running: false, room: undefined, removeListener() {} };
    this.current = this.placeholder;

    this.onSessionChanged = async (controller) => {};
    this.onError = async (error) => {};
  }

  setMyManagerFactory(factory) {
    this.myFactory = factory;
  }

  setRoomManagerFactory(factory) {
    this.roomManagerFactory = factory;
  }

  async match(preferSetting) {
    try {
      const game          = this.gameFactory();
      const roomManager   = this.roomManagerFactory(this.myFactory);

      const session       = new Contoller(game, roomManager);
      session.onError     = this.onError;
      session.onStoppable = this.onStoppable;
      session.onConfirm   = this.onConfirm;
      session.onAlert     = this.onAlert;

      // `session` just a placeholder now, so the listener cannot anything
      // meanable.
      await this.setCurrent(session);

      await session.match(preferSetting);
    } catch (e) {
      await this.setCurrent();
      if (e instanceof CancelPromiseError) {
        console.warn(e);
      } else {
        console.error(e);
        this.onError(e);
      }
    }
  }

  async continueRoom() {
    assert(this.current);

    try {
      await this.current.continueRoom();
    } catch (e) {
      await this.setCurrent();
      if (e instanceof CancelPromiseError) {
        console.warn(e);
      } else {
        console.error(e);
        this.onError(e);
      }
    }
  }

  async setCurrent(session = this.current) {
    if (this.current) {
      this.current.removeListener();
    }
    this.current = session;
    await this.onSessionChanged(session);
  }
}
