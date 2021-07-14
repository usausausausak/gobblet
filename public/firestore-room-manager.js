import {
  GobbletSetting,
  NoRoomError, RoomFullError,
  GameExceptionError, LeaveException, WaitTimeoutException, StepLimitException,
} from './gobblet.js';
import { assert, assertNot, randomId, vaildId, delay, TimeoutError, timeout } from './util.js';

class RemotePlayerManager {
  constructor(stepsRef, db, listener, timeoutSecond = 60) {
    this.stepsRef = stepsRef;
    this.timeoutTime = timeoutSecond * 1000;

    this.db = db;
    this.listener = listener;
  }

  async recvStep(step) {
    await this.stepsRef.doc(`step-${step.seq}`).set(step);
  }

  async getStep(controller) {
    await controller.onWaiting();

    let stepPromise = this.listener.getStepPromise();

    if (this.timeoutTime) {
      const timeoutPromise = timeout(this.timeoutTime);
      stepPromise = Promise.race([stepPromise, timeoutPromise]);
    }

    const step = await stepPromise.finally(() => this.listener.dropPromise());

    await controller.onSelectPhase();
    await controller.onSelectedHand(step.handFrom, step.handIdx);
    await delay(250);

    await controller.onPlacePhase();
    await controller.onSelectedHand('board', step.placeIdx);
    await delay(250);

    await controller.onWaitingEnd();

    return step;
  }
}

class ViewerPlayerManager extends RemotePlayerManager {
  constructor(stepsRef, db, listener) {
    super(stepsRef, db, listener, 0);
  }

  async recvStep(step) {
    // pass
  }
}

class RemoteRoomManager {
  constructor(defaultPlayerAFactory, db, listener) {
    this.defaultPlayerAFactory = defaultPlayerAFactory;

    this.room     = undefined;

    this.roomRef  = undefined;
    this.stepsRef = undefined;

    this.db       = db;
    this.listener = listener;
  }

  async createRoom(preferSetting) {
    this.assertNoRoom();

    const roomId = randomId(8);
    const privateRoom = !!preferSetting.privateRoom;
    const localCreateTime = new Date();

    const room = {
      id: roomId, rev: 1,
      boardSize: preferSetting.boardSize.toString(),
      ownerFirst: (preferSetting.order == GobbletSetting.orderFirst),
      privateRoom,
      createTime: firebase.firestore.FieldValue.serverTimestamp(),
      joinTime: null,
      endTime: null,
    };

    const roomKind = (privateRoom) ? 'private' : 'public';
    const roomsRef = this.db.collection(roomKind);
    const roomRef = await roomsRef.add(room);

    this.roomRef = roomRef;
    console.info('{', this.roomRef.id, '} room created:', preferSetting);

    room.myRoom = true;
    room.viewMode = false;
    room.localCreateTime = localCreateTime;

    this.room = room;
    return room;
  }

  async waitForPlayerJoin() {
    assert(this.room);
    assert(this.roomRef);

    // and wait for player.
    const [roomPromise, unsubscribe] = this.listener.listenPlayerJoin(this.roomRef);
    const remoteRoom = await roomPromise.finally(() => {
      console.info('{', this.roomRef.id, '} stop listen player join');
      unsubscribe();
    });

    assert(remoteRoom.id == this.room.id);

    const room = this.room;
    room.joinTime = remoteRoom.joinTime;
    room.localJoinTime = new Date();

    return this.useRoom(room);
  }

  async attachPublicRoom(preferSetting) {
    this.assertNoRoom();

    preferSetting.privateRoom = false;

    const roomsRef = this.db.collection('public');

    const roomQuery = roomsRef.limit(1)
      .where('endTime', '==', null)
      .where('joinTime', '==', null)
      .where('privateRoom', '==', false);
    const roomSnapshot = await roomQuery.get();

    if (roomSnapshot.size == 0) {
      console.log('{ manager } no public room');
      return undefined;
    }

    const roomDoc = roomSnapshot.docs[0];

    this.roomRef = roomDoc.ref;
    console.info('{', this.roomRef.id, '} room found');

    const room = { ...roomDoc.data() };
    room.myRoom = false;
    room.viewMode = false;
    room.localCreateTime = new Date(); // TODO: from timestamp
    room.localJoinTime = new Date();

    this.room = room;
    return room;
  }

  async attachRoom(roomId) {
    this.assertNoRoom();
    if (!vaildId(roomId, 8)) {
      throw new NoRoomError(roomId);
    }

    const findFrom = async (kind) => {
      console.log('{ manager } find from:', kind);
      const roomsRef = this.db.collection(kind);

      const roomQuery = roomsRef.where('id', '==', roomId).limit(1);
      let roomSnapshot = await roomQuery.get();

      if (roomSnapshot.size > 0) {
        return roomSnapshot.docs[0];
      } else {
        return undefined;
      }
    };

    const roomDoc = await findFrom('private') || await findFrom('public');
    if (!roomDoc) {
      throw new NoRoomError(roomId);
    }

    this.roomRef = roomDoc.ref;
    console.info('{', this.roomRef.id, '} room found');

    const room = { ...roomDoc.data() };

    if ((room.joinTime == null) && (room.endTime != null)) {
      throw new NoRoomError(roomId);
    }

    room.myRoom = false;
    room.viewMode = false;
    room.localCreateTime = new Date(); // TODO: from timestamp
    room.localJoinTime = new Date();

    this.room = room;
    return room;
  }

  async joinRoom() {
    const room = this.room;

    if ((room.joinTime != null) || (room.endTime != null)) {
      throw new RoomFullError();
    }

    // i think this is threw by joining a full room, try to rematch.
    try {
      await this.roomRef.update({ joinTime: firebase.firestore.FieldValue.serverTimestamp() });
    } catch (e) {
      console.warn('i think this is threw by joining a full room, try to rematch.');
      throw new RoomFullError();
    }
    console.info('{', this.roomRef.id, '} join room');

    room.viewMode = false;
    return this.useRoom(room);
  }

  async viewRoom() {
    const room = this.room;

    assert(room.joinTime != null);
    console.info('{', this.roomRef.id, '} play room record');

    room.viewMode = true;
    return this.useRoom(room);
  }

  async updateRoom() {
    assert(this.room.myPrivateRoom);
    const room = this.room;

    ++room.rev;
    room.joinTime  = null;
    room.endTime   = null;
    room.boardSize = room.boardSize.toString(),

    // TODO: record update time
    await this.roomRef.update({
      rev: room.rev,
      joinTime: null,
      endTime: null,
    });
    console.info('{', this.roomRef.id, '} update room, rev:', room.rev);

    return room;
  }

  useRoom(room) {
    this.stepsRef = this.roomRef.collection(`steps-${this.room.rev}`);
    this.listener.listen(this.stepsRef, this.roomRef.id);

    // for local use.
    room.boardSize = GobbletSetting.fromString(room.boardSize);
    room.myPrivateRoom = ((room.myRoom) && (room.privateRoom));
    room.localEndTime = undefined;

    this.room = room;

    console.log('{', this.roomRef.id, '} use room:', room);

    return room;
  }

  async stopMatchRoom() {
    await this.roomRef.update({ endTime: firebase.firestore.FieldValue.serverTimestamp() });
    await this.detachRoom();
  }

  async detachRoom() {
    this.room = undefined;
    if (this.listener.listening) {
      this.listener.stop();
    }
    this.assertNoRoom();
  }

  async stopRoom() {
    this.listener.stop();
    this.assertRoomStopping();
  }

  async endRoom() {
    await this.roomRef.update({ endTime: firebase.firestore.FieldValue.serverTimestamp() });
    this.stopRoom();
  }

  async endRoomWithException(exception) {
    await this.sendException(exception);
    await this.endRoom();
  }

  async sendException(exception) {
    await this.stepsRef.doc('exception').set(exception);
  }

  assertNoRoom() {
    assertNot(this.room);
    assertNot(this.listener.listening);
  }

  assertRoomStopping() {
    assert(this.room);
    assertNot(this.listener.listening);
  }

  getPlayerAManager() {
    assert(this.room);
    assert((this.roomRef) && (this.stepsRef));

    if (this.room.viewMode) {
      return new ViewerPlayerManager(this.stepsRef, this.db, this.listener);
    } else {
      return new this.defaultPlayerAFactory();
    }
  }

  getPlayerBManager() {
    assert(this.room);
    assert((this.roomRef) && (this.stepsRef));

    if (this.room.viewMode) {
      return new ViewerPlayerManager(this.stepsRef, this.db, this.listener);
    } else {
      return new RemotePlayerManager(this.stepsRef, this.db, this.listener);
    }
  }
}

class RemoteRoomListener {
  constructor(db) {
    this.roomDocId = undefined;
    this.unsubscribe = undefined;

    this.savedStep = undefined;
    this.savedException = undefined;

    this._stepFuture = undefined;

    this.db = db;
  }

  listen(stepsRef, roomDocId) {
    assert(!this.unsubscribe);

    console.info('{', roomDocId, '} start room listener');
    this.roomDocId = roomDocId;

    this.savedStep = [];
    this.savedException = [];

    this._stepFuture = undefined;

    this.unsubscribe = stepsRef.onSnapshot(snapshot => {
      const newStep = [];
      snapshot.docChanges().forEach(change => {
        if (change.doc.metadata.hasPendingWrites) {
          const doc = { ...change.doc.data() };
          console.log('{', this.roomDocId, '} skip:', doc);
          return;
        }

        if (change.type == 'added') {
          const doc = { ...change.doc.data() };
          if (doc.exception) {
            this.savedException.push(doc);
          } else {
            newStep.push(doc);
          }
          console.log('{', this.roomDocId, '} added:', doc);
        } else if (change.type == 'modified') {
          const doc = { ...change.doc.data() };
          if (doc.exception) {
            this.savedException.push(doc);
          } else {
            console.warn('{', this.roomDocId, '} unreachable:', change.type, doc);
          }
        } else {
          console.warn('{', this.roomDocId, '} unreachable:', change.type, doc);
        }
      });

      console.log('{', this.roomDocId, '} sort recved step by `seq`');
      newStep.sort((a, b) => a.seq - b.seq);
      this.savedStep.push(...newStep);

      //console.log('recved:', this.savedStep.length);
      //this.savedStep.forEach(e => console.log(e));

      if (this._stepFuture) {
        this.resolveSavedStep();
      }
    }, e => {
      this.unsubscribe = undefined;
      this._stepFuture = undefined;
      console.warn('{', this.roomDocId, '} stop room listener unexpected');
      console.error(e);
    });
  }

  resolveSavedStep() {
    assert(this._stepFuture);

    const resolve = (v) => {
      this._stepFuture.resolve(v);
      this._stepFuture = undefined;
    };

    const reject = (v) => {
      this._stepFuture.reject(v);
      this._stepFuture = undefined;
    };

    if (this.savedStep.length > 0) {
      const firstUnrecv = this.savedStep.shift();
      resolve(firstUnrecv);
    } else if (this.savedException.length > 0) {
      const firstUnrecv = this.savedException.shift();
      switch (firstUnrecv.exception) {
        case 'leave':
          reject(new LeaveException(firstUnrecv.color));
          break;
        case 'step-limit':
          reject(new StepLimitException());
          break;
        case 'wait-timeout':
          reject(new WaitTimeoutException(firstUnrecv.color));
          break;
        default:
          reject(new GameExceptionError(firstUnrecv.exception));
          break;
      }
    }
  }

  stop() {
    assert(this.unsubscribe);
    console.info('{', this.roomDocId, '} stop room listener');
    this._stepFuture = undefined;

    this.unsubscribe();
    this.unsubscribe = undefined;
  }

  getStepPromise() {
    assert(this.unsubscribe);
    assert(!this._stepFuture);

    const promise = new Promise((resolve, reject) => {
      this._stepFuture = { resolve, reject };
    });

    this.resolveSavedStep();
    return promise;
  }

  listenPlayerJoin(roomRef) {
    let unsubscribe;
    const promise = new Promise((resolve, reject) => {
      unsubscribe = roomRef.onSnapshot(roomDoc => {
        const room = { ...roomDoc.data() };
        if (room.joinTime != null) {
          console.info('{', roomDoc.id, '} player join');
          unsubscribe();
          resolve(room);
        }
      }, e => reject(e));
    });

    return [promise, unsubscribe];
  }

  // always drop the old promise(should losed at `race`).
  dropPromise() {
    console.log('{', this.roomDocId, '} dropped futures')
    this._stepFuture = undefined;
  }

  get listening() {
    return !!this.unsubscribe;
  }
}

let firestoreDb = undefined;
export function remoteRoomManagerFactory(defaultPlayerAFactory, db) {
  if (!db) {
    if (!firestoreDb) {
      firestoreDb = firebase.firestore();
    }
    db = firestoreDb;
  }

  const listener = new RemoteRoomListener(db);
  return new RemoteRoomManager(defaultPlayerAFactory, db, listener);
}
