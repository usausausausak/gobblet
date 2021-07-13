import {
  GobbletSetting,
  NoRoomError, RoomFullError,
  GameExceptionError, LeaveException, WaitTimeoutException, StepLimitException,
} from './gobblet.js';
import { assert, assertNot, randomId, vaildId, delay, TimeoutError, timeout } from './util.js';

class RemotePlayerManager {
  constructor(roomDocId, db, listener, timeoutSecond = 60) {
    this.roomDocId = roomDocId;
    this.timeoutTime = timeoutSecond * 1000;

    this.db = db;
    this.listener = listener;
  }

  async recvStep(step) {
    const stepsRef = this.db.collection(`room/${this.roomDocId}/step`);
    await stepsRef.doc(`step-${step.seq}`).set(step);
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
  constructor(roomDocId, db, listener) {
    super(roomDocId, db, listener, 0);
  }

  async recvStep(step) {
    // pass
  }
}

class RemoteRoomManager {
  constructor(defaultPlayerAFactory, db, listener) {
    this.defaultPlayerAFactory = defaultPlayerAFactory;

    this.room = undefined;

    this.roomRef = undefined;

    this.db = db;
    this.listener = listener;
  }

  async createRoom(preferSetting) {
    this.assertNoRoom();

    const roomId = randomId(8);
    const localCreateTime = new Date();

    const room = {
      id: roomId,
      boardSize: preferSetting.boardSize.toString(),
      ownerFirst: (preferSetting.order == GobbletSetting.orderFirst),
      privateRoom: !!preferSetting.privateRoom,
      createTime: firebase.firestore.FieldValue.serverTimestamp(),
      joinTime: null,
      endTime: null,
    };

    const roomsRef = this.db.collection('room');
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

    const roomsRef = this.db.collection('room');
    //.orderBy('createTime', 'desc').limit(1);

    const roomQuery = roomsRef.limit(1)
      .where('endTime', '==', null)
      .where('joinTime', '==', null)
      .where('privateRoom', '==', false);
    const roomSnapshot = await roomQuery.get();

    if (roomSnapshot.size == 0) {
      console.log('{ } no public room');
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

    const roomsRef = this.db.collection('room');
    //.orderBy('createTime', 'desc').limit(1);

    const roomQuery = roomsRef.where('id', '==', roomId).limit(1);
    const roomSnapshot = await roomQuery.get();

    if (roomSnapshot.size == 0) {
      throw new NoRoomError(roomId);
    }

    const roomDoc = roomSnapshot.docs[0];

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

    await this.roomRef.update({ joinTime: firebase.firestore.FieldValue.serverTimestamp() });
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

  useRoom(room) {
    this.listener.listen(this.roomRef.id);

    // for local use.
    room.boardSize = GobbletSetting.fromString(room.boardSize);

    this.room = room;

    console.log('{', this.roomRef.id, '} use room:', room);

    return room;
  }

  async stopMatchRoom() {
    await this.roomRef.update({ endTime: firebase.firestore.FieldValue.serverTimestamp() });

    this.room = undefined;
    this.assertNoRoom();
  }

  async detachRoom() {
    this.room = undefined;
    this.listener.stop();
    this.assertNoRoom();
  }

  async endRoom() {
    await this.roomRef.update({ endTime: firebase.firestore.FieldValue.serverTimestamp() });
    await this.detachRoom();
  }

  async endRoomWithException(exception) {
    await this.sendException(exception);
    await this.endRoom();
  }

  async sendException(exception) {
    const stepsRef = this.roomRef.collection('step');
    await stepsRef.doc('exception').set(exception);
  }

  assertNoRoom() {
    assertNot(this.room);
    assertNot(this.listener.listening);
  }

  getPlayerAManager() {
    assert(this.room);
    assert(this.roomRef);

    if (this.room.viewMode) {
      return new ViewerPlayerManager(this.roomRef.id, this.db, this.listener);
    } else {
      return new this.defaultPlayerAFactory();
    }
  }

  getPlayerBManager() {
    assert(this.room);
    assert(this.roomRef);

    if (this.room.viewMode) {
      return new ViewerPlayerManager(this.roomRef.id, this.db, this.listener);
    } else {
      return new RemotePlayerManager(this.roomRef.id, this.db, this.listener);
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

  listen(roomDocId) {
    assert(!this.unsubscribe);

    console.info('{', roomDocId, '} start room listener');
    this.roomDocId = roomDocId;

    this.savedStep = [];
    this.savedException = [];

    this._stepFuture = undefined;

    const stepsRef = this.db.collection(`room/${roomDocId}/step`);
    this.unsubscribe = stepsRef.onSnapshot(snapshot => {
      const newStep = [];
      snapshot.docChanges().forEach(change => {
        if (change.doc.metadata.hasPendingWrites) {
          const doc = { ...change.doc.data() };
          console.log('{', roomDocId, '} skip:', doc);
          return;
        }

        if (change.type == 'added') {
          const doc = { ...change.doc.data() };
          if (doc.exception) {
            this.savedException.push(doc);
          } else {
            newStep.push(doc);
          }
          console.log('{', roomDocId, '} added:', doc);
        } else if (change.type == 'modified') {
          const doc = { ...change.doc.data() };
          if (doc.exception) {
            this.savedException.push(doc);
          } else {
            console.warn('{', roomDocId, '} unreachable:', change.type, doc);
          }
        } else {
          console.warn('{', roomDocId, '} unreachable:', change.type, doc);
        }
      });

      console.log('{', roomDocId, '} sort recved step by `seq`');
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
      this._futureMap.clear();
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
export function remoteRoomManagerFactory(defaultPlayerAFactory) {
  if (!firestoreDb) {
    firestoreDb = firebase.firestore();
  }

  const listener = new RemoteRoomListener(firestoreDb);
  return new RemoteRoomManager(defaultPlayerAFactory, firestoreDb, listener);
}
