import {
  NoRoomError, RoomFullError, LeaveRoomError,
  LeaveException, WaitTimeoutException, StepLimitException,
} from './gobblet.js';
import { TimeoutError, assert, assertNot, delay, NamedPromise } from './util.js';

export class Contoller {
  constructor(game, roomManager) {
    this.game = game;
    this.manager = {
      room: roomManager,
      playerA: undefined,
      playerB: undefined,
    };

    this.me        = undefined;
    this.islander  = undefined;

    this.running     = undefined;
    this.suspending  = undefined;
    this.myTurn      = undefined;
    this.iAmLeaved   = undefined;
    this.stopPromise = undefined;

    this.rematchTry = 3;

    this.useDefaultListener();
  }

  async match(preferSetting) {
    this.manager.room.assertNoRoom();

    try {
      this.running    = true;
      this.suspending = true;

      console.info('[ new session ] matching room');

      await this.onGameMatching();

      if (preferSetting.roomId) {
        await this.joinOrView(preferSetting);
      } else {
        await this.joinOrCreate(preferSetting);
      }
    } catch (e) {
      await this.drop();
      console.error(e);
      await this.onError(e);
    }
  }

  // should be called before every exit points
  async drop() {
    this.running     = undefined;
    this.suspending  = undefined;
    this.myTurn      = undefined;
    this.iAmLeaved   = undefined;
    this.stopPromise = undefined;

    this.rematchTry = 3;

    await this.onSessionEnd();

  }

  async joinOrCreate(preferSetting) {
    try {
      console.log('match room:', preferSetting);

      if (!preferSetting.privateRoom) {
        await this.manager.room.attachPublicRoom(preferSetting);
      }

      if (!this.manager.room.room) {
        await this.onMatchingPhase('create');
        await this.manager.room.createRoom(preferSetting);

        await this.onMatchingPhase('wait', this.manager.room.room);
        this.stopPromise = this.onStoppable();
        const waitPromise = this.manager.room.waitForPlayerJoin();
        await Promise.race([waitPromise, this.stopPromise]);
      } else {
        await this.onMatchingPhase('join', this.manager.room.room);
        this.stopPromise = this.onStoppable();
        await this.manager.room.joinRoom();
      }

      await this.start();
    } catch (e) {
      if (e instanceof RoomFullError) {
        await this.rematchWhenFull(preferSetting);
      } else if (e instanceof LeaveRoomError) {
        // only create room throw this error, so we always set remote data in
        // the `stoppedWaitForPlayer`
        await this.stoppedWaitForPlayer();
      } else {
        throw e;
      }
    }
  }

  async joinOrView(preferSetting) {
    try {
      console.log('find room:', preferSetting.roomId);

      await this.manager.room.attachRoom(preferSetting.roomId);

      await this.onMatchingPhase('join', this.manager.room.room);
      if (!this.manager.room.room.joinTime) {
        await this.manager.room.joinRoom();
      } else {
        const answer = await this.onConfirm((this.manager.room.room.endTime) ? 'replay-mode' : 'view-mode');
        if (answer) {
          await this.manager.room.viewRoom();
        } else {
          throw new RoomFullError();
        }
      }

      this.stopPromise = this.onStoppable();

      await this.start();
    } catch (e) {
      if (e instanceof NamedPromise.CancelPromiseError) {
        console.debug(e);
        if (this.game.room) {
          console.info('[', this.game.room.id, '] you leaved page, stop session');
        } else {
          console.info('[ new session ] you leaved page, stop session');
        }
        await this.drop();
        await this.onGameLeaved();
      } else if (e instanceof NoRoomError) {
        await this.roomNotFound(e.roomId);
      } else if (e instanceof RoomFullError) {
        this.rematchTry = 0; // noretry
        await this.rematchWhenFull(preferSetting);
      } else {
        throw e;
      }
    }
  }

  async rematchWhenFull(preferSetting) {
    if (this.rematchTry > 0) {
      --this.rematchTry;

      try {
        // TODO: no constant
        const waitBeforeRematch = 5;
        console.log('found a fulled room, rematch after', waitBeforeRematch, 'seconds');
        await Promise.race([delay(waitBeforeRematch * 1000), this.stopPromise]);
      } catch (e) {
        if (e instanceof LeaveRoomError) {
          console.info('[ new session ] no room match');

          await this.drop();
          await this.onGameLeaved();
          return;
        }
      }

      this.manager.room.detachRoom();
      this.match(preferSetting);
    } else {
      console.info('[ new session ] no room match');
      await this.onAlert('no-room-match');

      await this.drop();
      await this.onGameLeaved();
    }
  }

  async stoppedWaitForPlayer() {
    console.info('[ new session ] you stopped matching');

    await this.manager.room.stopMatchRoom();

    await this.drop();
    await this.onGameLeaved();
  }

  async roomNotFound(roomId) {
    console.info('[ new session ] room not found or closed:', roomId);
    await this.onAlert('no-room', { roomId });

    await this.drop();
    await this.onGameLeaved();
  }

  async continueRoom() {
    assert(!this.running);
    this.manager.room.assertRoomStopping();
    assert(this.manager.room.room.myPrivateRoom);

    try {
      this.running    = true;
      this.suspending = true;

      await this.onGameMatching();
      console.info('[ new session ] continue private room:', this.manager.room.room);

      await this.onMatchingPhase('update');
      await this.manager.room.updateRoom();

      await this.onMatchingPhase('wait', this.manager.room.room);
      this.stopPromise = this.onStoppable();
      const waitPromise = this.manager.room.waitForPlayerJoin();
      await Promise.race([waitPromise, this.stopPromise]);

      await this.start();
    } catch (e) {
      if (e instanceof LeaveRoomError) {
        await this.stoppedWaitForPlayer();
      } else {
        throw e;
      }
    }
  }

  async start() {
    this.manager.playerA = this.manager.room.getPlayerAManager();
    this.manager.playerB = this.manager.room.getPlayerBManager();

    const room = this.manager.room.room;
    console.info('[', room.id, '] room start');

    this.game.newGame(room);

    this.me        = this.getAController();
    this.islander  = this.getBController();

    this.myTurn    = (this.game.playerA.color == 'red');
    this.iAmLeaved = false;

    await this.onGameStart({
      room:            this.game.room,
      board:           this.game.board,
      me:              this.me.player,
      islander:        this.islander.player,
      startWithMyTurn: this.myTurn,
    });

    try {
      while (this.running) {
        await this.turnStart();
      }
    } catch (e) {
      await this.manager.room.stopRoom();

      console.error(e);
      this.drop();
      await this.onError(e, this.game.room);
    }
  }

  async turnStart() {
    try {
      const playerCtrl = (this.myTurn) ? this.me : this.islander;
      console.info('[', this.game.room.id, '] turn start:', playerCtrl.player.color);

      if (this.iAmLeaved) {
        console.log('but i am leaved');
        throw new LeaveRoomError();
      }

      await playerCtrl.onTurnStart();

      const stepPromise = playerCtrl.manager.getStep(playerCtrl);
      const step = await Promise.race([stepPromise, this.stopPromise]);
      step.seq = this.game.boardCommits.length;
      console.log('step:', step);

      const commits = await playerCtrl.performStep(step, playerCtrl);
      await this.onBoardChanged(commits);

      await playerCtrl.onTurnEnd();

      if (!this.game.room.viewMode) {
        await playerCtrl.playerB.onWaiting();
        await playerCtrl.playerB.manager.recvStep(step);
        await playerCtrl.playerB.onWaitingEnd();
      }

      await this.turnEnd();
    } catch (e) {
      if (e instanceof NamedPromise.CancelPromiseError) {
        console.debug(e);
        console.info('[', this.game.room.id, '] you leaved page, stop session');
        await this.leaveRoom();
      } else if (e instanceof LeaveRoomError) {
        await this.leaveRoom();
      } else if (e instanceof TimeoutError) {
        await this.oppositeTimeout(e.waitedTime);
      } else if (e instanceof LeaveException) {
        await this.someoneLeaved(e.color);
      } else if (e instanceof WaitTimeoutException) {
        await this.someoneLeaved(e.color, 'wait-timeout');
      } else if (e instanceof StepLimitException) {
        await this.reachStepLimit();
      } else {
        throw e;
      }
    }
  }

  async turnEnd() {
    const winner = this.game.detectWinner();

    if (winner) {
      console.info('[', this.game.room.id, '] winner:', winner);
      const shouldReport = ((this.game.room.myRoom) && (!this.game.room.viewMode));
      if (shouldReport) {
        await this.manager.room.endRoom();
      } else {
        await this.manager.room.stopRoom();
      }

      await this.drop();
      await this.onGameSet(winner, this.me.player.color);
    } else if (this.game.reachStepLimit) {
      throw new StepLimitException();
    } else {
      this.myTurn = !this.myTurn;
    }
  }

  async leaveRoom(reason = 'leave') {
    console.info('[', this.game.room.id, '] i am leaved, reason:', reason);
    this.iAmLeaved = true;

    const exception = {
      exception: reason,
      color: this.me.player.color,
    };

    if (this.game.room.viewMode) {
      await this.manager.room.stopRoom();
    } else {
      await this.manager.room.endRoomWithException(exception);
    }

    await this.drop();
    await this.onGameLeaved();
  }

  async oppositeTimeout(waitedTime) {
    assertNot(this.myTurn);

    const continuePromise = (this.game.room.myPrivateRoom)
      ? this.kickTimeout(waitedTime) : this.continueTimeout(waitedTime);

    await continuePromise;
  }

  async continueTimeout(waitedTime) {
    const iContinue = await this.onConfirm('timeout', { waitedTime: waitedTime / 1000 });

    if (!iContinue) {
      console.warn('[', this.game.room.id, '] player:', this.islander.player.color, 'is timeout');

      await this.leaveRoom('wait-timeout');
    }
  }

  async kickTimeout(waitedTime) {
    const iKick = await this.onConfirm('kick-timeout', { waitedTime: waitedTime / 1000 });

    if (iKick) {
      console.warn('[', this.game.room.id, '] player:', this.me.player.color, 'is timeout');

      const exception = {
        exception: 'wait-timeout',
        color: this.me.player.color,
      };
      await this.manager.room.endRoomWithException(exception);

      await this.drop();
      await this.onGameInterrupted(this.me.player.color, this.me.player.color);
    }
  }

  async someoneLeaved(leavedColor, reason = 'no-reason') {
    console.warn('[', this.game.room.id, '] player:', leavedColor, 'is leaved:', reason);
    await this.manager.room.stopRoom();

    await this.drop();
    await this.onGameInterrupted(leavedColor, this.me.player.color);
  }

  async reachStepLimit() {
    console.warn('[', this.game.room.id, '] reach steps limit:', this.game.boardCommits.length);
    const exception = { exception: 'step-limit' };

    if (this.game.room.viewMode) {
      await this.manager.room.stopRoom();
    } else {
      await this.manager.room.endRoomWithException(exception);
    }
    await this.drop();
    await this.onGameInterrupted('step-limit', this.me.player.color);
  }

  useDefaultListener() {
    this.onSessionEnd           = async () => {};
    this.onError                = async (error, room) => {};

    this.onStoppable            = () => Promise.reject(new LeaveRoomError());
    this.onConfirm              = async (msgId, fmtArgs) => Promise.resolve(false);
    this.onAlert                = async (msgId, fmtArgs) => Promise.resolve(true);

    // view changed
    this.onGameMatching         = async () => {};
    this.onMatchingPhase        = async (room) => {};
    this.onGameStart            = async (vmmodel) => {};
    this.onGameInterrupted      = async (iAmLeaved) => {};
    this.onGameSet              = async (winner, myColor) => {};
    this.onGameLeaved           = async () => {};

    this.onBoardChanged         = async (commits) => {};

    this.eventListenerA = {
      onSelectedHand: async (handFrom, hand) => {},
      onUnselectedHand: async (handFrom, hand) => {},
      onTurnStart: async () => {},
      onSelectPhase: async () => {},
      onPlacePhase: async () => {},
      onTurnEnd: async () => {},
      onWarning: async (msgId) => {},
      onWaiting: async () => {},
      onWaitingEnd: async () => {},
    };

    this.eventListenerB = {
      onSelectedHand: async (handFrom, hand) => {},
      onUnselectedHand: async (handFrom, hand) => {},
      onTurnStart: async () => {},
      onSelectPhase: async () => {},
      onPlacePhase: async () => {},
      onTurnEnd: async () => {},
      onWarning: async (msgId) => {},
      onWaiting: async () => {},
      onWaitingEnd: async () => {},
    };
  }

  removeListener() {
    this.useDefaultListener();
  }

  getAController() {
    const listenerA = this.bindPlayerListener('eventListenerA');
    const listenerB = this.bindPlayerListener('eventListenerB');
    return {
      game: this.game,
      manager: this.manager.playerA,
      board: this.game.board,
      player: this.game.playerA,
      performStep: (step) => this.game.performStep(step, this.game.playerA),
      ...listenerA,
      playerB: {
        manager: this.manager.playerB,
        player: this.game.playerB,
        ...listenerB,
      },
    };
  }

  getBController() {
    const listenerA = this.bindPlayerListener('eventListenerA');
    const listenerB = this.bindPlayerListener('eventListenerB');
    return {
      game: this.game,
      manager: this.manager.playerB,
      board: this.game.board,
      player: this.game.playerB,
      performStep: (step) => this.game.performStep(step, this.game.playerB),
      ...listenerB,
      playerB: {
        manager: this.manager.playerA,
        player: this.game.playerA,
        ...listenerA,
      },
    };
  }

  bindPlayerListener(key) {
    const binded = {};
    const events = [
      'onUnselectedHand', 'onSelectedHand',
      'onTurnStart', 'onSelectPhase', 'onPlacePhase', 'onTurnEnd',
      'onWarning', 'onWaiting', 'onWaitingEnd',
    ];
    events.forEach(e => {
      binded[e] = (...args) => this[key][e](...args);
    })
    return binded;
  }

  get room() {
    return this.manager.room.room;
  }
}
