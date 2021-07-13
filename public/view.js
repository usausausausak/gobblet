import { LeaveRoomError } from './gobblet.js';
import * as roomManager from './single-seat-room-manager.js';
import { LocalRoomManager } from './local-room-manager.js';
import { NamedPromise, unreachable, delay, itemAt } from './util.js';

export class View {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;

    this.view      = document.getElementById('view');
    this.result    = document.getElementById('dialog-result');
    this.playend   = document.getElementById('dialog-playend');
    this.error     = document.getElementById('error-message');

    this.matchInfo = document.getElementById('match-info');
    this.roomId    = document.getElementById('room-id');

    this.board     = document.getElementById('board');
    this.board.getPlaceByIdx = function (placeIdx) {
      return this.querySelector(`[data-place-idx="${placeIdx}"]`);
    };

    this.me = {
      hands: document.getElementById('my-hands'),
      _message: document.getElementById('me-message'),
      getHandByIdx(handIdx) {
        return this.hands.querySelector(`[data-hand-idx="${handIdx}"]`);
      },
      message(msgId) {
        this._message.classList.add('message-display');
        this._message.textContent = this.getString(msgId);
      },
      messageEnd() {
        this._message.classList.remove('message-display');
      },
      getString: this.getString,
    };

    this.islander = {
      hands: document.getElementById('islanders-hands'),
      _message: document.getElementById('islander-message'),
      getHandByIdx(handIdx) {
        return this.hands.querySelector(`[data-hand-idx="${handIdx}"]`);
      },
      message(msgId) {
        this._message.classList.add('message-display');
        this._message.textContent = this.getString(msgId);
      },
      messageEnd() {
        this._message.classList.remove('message-display');
      },
      getString: this.getString,
    };

    const template = document.getElementById('board-template').content;
    this.hand = template.getElementById('hand');
    this.hand.removeAttribute('id');

    this.place = template.getElementById('place');
    this.place.removeAttribute('id');
    this.place.appendChild(this.hand.cloneNode(true));

    // listen session
    sessionManager.onSessionChanged = async (controller) => {
      this.clearView();
      this.setController(controller);
    }

    // onStoppable
    sessionManager.onStoppable = async () => {
      await NamedPromise.create('SessionPromise');
      // TODO: do not use private variable
      const localRoom = (this.controller.manager.room instanceof LocalRoomManager);
      if ((localRoom) || (!this.controller.running) || (this.controller.room.viewMode)) {
        this.controller.iAmLeaved = true;
        throw new LeaveRoomError();
      }

      const answer = await this.controller.onConfirm('leave');
      if (answer) {
        this.controller.iAmLeaved = true;
        throw new LeaveRoomError();
      }

      // wait user action again.
      return this.controller.onStoppable();
    };

    const messageDialogs = [
      ['onConfirm', 'dialog-confirm', 'confirm-message', false],
      ['onAlert',   'dialog-alert',   'alert-message',   true],
    ];
    for (let [event, viewId, messageViewId, alwaysResolve] of messageDialogs) {
      const dialog = document.getElementById(viewId);
      const message = document.getElementById(messageViewId);

      sessionManager[event] = async (msgId, fmtArgs) => {
        this.controller.suspending = true;
        dialog.classList.add('overlay');
        message.textContent = this.getString(msgId, fmtArgs);
        return NamedPromise.create('MessagePromise')
          .catch(e => {
            return (alwaysResolve) ? alwaysResolve : Promise.reject(e);
          })
          .finally(() => {
            this.controller.suspending = false;
            dialog.classList.remove('overlay');
          });
      }
    }

    sessionManager.onError = async (e, roomData) => {
      let roomLog = '';
      if (roomData) {
        try {
          roomLog += '\n{\n';
          roomLog += `  id: ${roomData.id.toString()}, \n`;
          roomLog += `  ownerFirst: ${roomData.ownerFirst.toString()}, \n`;
          roomLog += `  boardSize: ${roomData.boardSize.toString()}, \n`;
          roomLog += `  createTime: ${roomData.createTime.toLocaleString()}, \n`;
          roomLog += `  joinTime: ${roomData.joinTime.toLocaleString()}, \n`;
          if (roomData.endTime) {
            roomLog += `  endTime: ${roomData.endTime.toLocaleString()}, \n`;
          }
          roomLog += `  localCreateTime: ${roomData.localCreateTime.toLocaleString()}, \n`;
          roomLog += `  localJoinTime: ${roomData.localJoinTime.toLocaleString()}, \n`;
          roomLog += '}';
        } catch (e) {
          roomLog = '';
          console.error(e);
        }
      }

      this.error.value = e.toString() + roomLog;

      this.changePage('error');
    };

    this.initNavEvents();

    // start
    this.startNav();
  }

  setController(controller) {
    controller.onSessionEnd = async () => {
      //console.log('session end');
      this.beforeNavPage();
      NamedPromise.cancel('InputPromise');
    };

    controller.onGameMatching = async () => {
      //console.log('session start');

      this.matchInfo.classList.remove('display');

      this.changePage({ pageId: 'match', newPage: true });
    };

    controller.onMatchingInfo = async (room) => {
      const url = new URL(window.location);
      url.hash = `#${room.id}`;

      const link = document.getElementById('match-room-link');
      link.textContent = room.id;
      link.href = url;

      this.matchInfo.classList.add('display');

      this.changePage({ pageId: 'match', room: { id: room.id } });
    };

    controller.onGameStart = async ({ room, board, me, islander, startWithMyTurn }) => {
      this.clearView();

      this.roomId.textContent = room.id;

      this.view.dataset.sqrt = Math.sqrt(board.length);
      this.view.dataset.viewMode = !!room.viewMode;
      this.result.dataset.winner = undefined;
      this.playend.dataset.winner = undefined;

      // TODO: do not use private variable
      this.me.hands.dataset.iHaveControl = (controller.me.manager instanceof roomManager.SingleSeatPlayerManager);
      this.islander.hands.dataset.iHaveControl = (controller.islander.manager instanceof roomManager.SingleSeatPlayerManager);

      if ((!startWithMyTurn)
          && (this.islander.hands.dataset.iHaveControl == 'true')) {
        this.view.classList.add('turn');
      }

      this.initBoard(board);
      this.initHands(this.me, me);
      this.initHands(this.islander, islander);
      this.initEvents();

      if (this.me.hands.dataset.color == 'blue') {
        this.board.classList.add('turn');
      }

      // we can reuse our private room.
      const localRoom =(controller.manager.room instanceof LocalRoomManager);
      const myPrivateRoom = ((room.myPrivateRoom) || (localRoom));
      const newGame = document.getElementById('new-game');
      if (myPrivateRoom) {
        newGame.style.display = '';
      } else {
        newGame.style.display = 'none';
      }

      this.changePage(room.id);
    };

    controller.onGameSet = async (winner, myColor) => {
      const pageId = (this.view.dataset.viewMode == 'true') ? 'playend' : 'result';
      const [seatA, seatB] = (!this.view.classList.contains('turn'))
        ? ['me', 'islander'] : ['islander', 'me'];

      switch (winner.color) {
        case 'draw':
          this[pageId].dataset.winner = 'draw';
          break;
        default:
          this[pageId].dataset.winner = (myColor == winner.color) ? seatA : seatB;
      }

      this.changePage(pageId);
    };

    controller.onGameInterrupted = async (reason, myColor) => {
      const pageId = (this.view.dataset.viewMode == 'true') ? 'playend' : 'result';
      if (reason == 'step-limit') {
        this[pageId].dataset.winner ='step-limit';
      } else {
        const [seatA, seatB] = (!this.view.classList.contains('turn'))
          ? ['me', 'islander'] : ['islander', 'me'];

        const leavedPlayer = (reason == myColor) ? seatA : seatB;
        this[pageId].dataset.winner = `${leavedPlayer}-leaved`;
      }

      this.changePage(pageId);
    };

    controller.onGameLeaved = async () => {
      this.changePage('choose');
    };

    controller.onBoardChanged = async (commits) => {
      for (let commit of commits) {
        this.stepBoard(commit);
      }
    };

    class EventListener {
      constructor(board, view) {
        this.board = board;
        this.view = view;
      }

      async onSelectedHand(selectedFrom, selectedHandIdx) {
        if (selectedFrom == 'board') {
          const hand = this.board.getPlaceByIdx(selectedHandIdx);
          hand.classList.add('hand-selected');
        } else {
          const hand = this.view.getHandByIdx(selectedHandIdx);
          hand.classList.add('hand-selected');
        }
      }

      async onUnselectedHand(selectedFrom, selectedHandIdx) {
        if (selectedFrom == 'board') {
          const hand = this.board.getPlaceByIdx(selectedHandIdx);
          hand.classList.remove('hand-selected');
        } else {
          const hand = this.view.getHandByIdx(selectedHandIdx);
          hand.classList.remove('hand-selected');
        }
      }

      async onSelectPhase() {
        this.board.dataset.selectable = this.view.hands.dataset.color;

        if (this.view.hands.dataset.iHaveControl == 'true') {
          this.view.message('hints1');
        }
      }

      async onPlacePhase() {
        this.board.dataset.selectable = 'all';

        if (this.view.hands.dataset.iHaveControl == 'true') {
          this.view.message('hints2');
        }
      }

      async onTurnEnd() {
        this.board.classList.remove('selectable');
        this.view.hands.classList.remove('selectable');
        this.view.messageEnd();
      }

      async onWarning(msgId) {
        this.view.message(this.view.getString(msgId));
      }

      async onWaiting(msgId) {
        this.view.message(this.view.getString('wait'));
      }

      async onWaitingEnd(msgId) {
        this.view.messageEnd();
      }
    }

    controller.eventListenerA = new EventListener(this.board, this.me);
    controller.eventListenerA.onTurnStart = async () => {
      if (this.me.hands.dataset.iHaveControl == 'true') {
        // animation use
        if (this.view.classList.contains('turn')) {
          await delay(200);
          this.view.classList.remove('turn');
        }

        this.me.hands.classList.add('selectable');
        this.board.classList.add('selectable');
      }
    };

    controller.eventListenerB = new EventListener(this.board, this.islander);
    controller.eventListenerB.onTurnStart = async () => {
      if (this.islander.hands.dataset.iHaveControl == 'true') {
        // animation use
        await delay(200);
        this.view.classList.add('turn');

        this.islander.hands.classList.add('selectable');
        this.board.classList.add('selectable');
      }
    };
  }

  clearView() {
    this.view.classList.remove('turn');
    this.board.classList.remove('turn');

    this.board.innerHTML = '';

    this.me.hands.innerHTML = '';
    this.islander.hands.innerHTML = '';

    this.me.messageEnd();
    this.islander.messageEnd();
  }

  getViewFromColor(color) {
    if (color == this.me.hands.dataset.color) {
      return this.me;
    } else if (color == this.islander.hands.dataset.color) {
      return this.islander;
    }  else {
      throw new Error('invaild-color');
    }
  }

  stepBoard(commit) {
    const popFromBoard = (commit) => {
      const hand = this.board.getPlaceByIdx(commit.idx);
      hand.dataset.color = commit.color;
      // animation request.
      if (commit.power > 0) {
        hand.dataset.power = commit.power;
      }
      hand.classList.remove('hand-selected');
      if (commit.color) {
        hand.classList.add('hand-placed');
      } else {
        hand.classList.remove('hand-placed');
      }
    };

    const popFromHand = (commit) => {
      const view = this.getViewFromColor(commit.playerColor);
      const hand = view.getHandByIdx(commit.idx);
      hand.dataset.color = commit.color;
      // animation request.
      if (commit.power > 0) {
        hand.dataset.power = commit.power;
      }
      hand.classList.remove('hand-selected');
      if (commit.color) {
        hand.classList.remove('hand-removed');
      } else {
        hand.classList.add('hand-removed');
      }
    };

    const push = (commit) => {
      const place = this.board.getPlaceByIdx(commit.idx);
      place.dataset.color = commit.color;
      place.dataset.power = commit.power;
      place.classList.remove('hand-selected');
      place.classList.add('hand-placed');
    };

    switch (commit.act) {
      case 'pop':
        switch (commit.handFrom) {
          case 'board': popFromBoard(commit); break;
          case 'hand':  popFromHand(commit);  break;
        }
        break;
      case 'push':  push(commit);  break;
      default:
        unreachable();
    }
  }

  initBoard(board) {
    for (let vmmodelPlaceStack of board) {
      const place = this.place.cloneNode(true);
      const hand = place.firstElementChild;
      hand.dataset.placeIdx = itemAt(vmmodelPlaceStack, -1).idx;
      hand.dataset.power = 0;
      hand.dataset.color = 'undefined';

      this.board.appendChild(place);
    }
  }

  initHands(player, vmmodel) {
    player.hands.dataset.color = vmmodel.color;

    let handIdx = 0;
    for (let vmmodelHandStack of vmmodel.hands) {
      const vmmodelHand = itemAt(vmmodelHandStack, -1);
      const hand = this.hand.cloneNode(true);
      hand.dataset.handIdx = vmmodelHand.idx;
      hand.dataset.power = vmmodelHand.power;
      hand.dataset.color = vmmodelHand.color;

      player.hands.appendChild(hand);
    }
  }

  initEvents() {
    function handPromiseResolve(handIdx, color) {
      const detail = {
        clickFrom: 'hand',
        handIdx,
        color,
      };
      NamedPromise.resolve('InputPromise', detail);
    }

    function placePromiseResolve(placeIdx) {
      const detail = {
        clickFrom: 'board',
        placeIdx,
      };
      NamedPromise.resolve('InputPromise', detail);
    }

    for (let place of this.board.children) {
      const hand = place.firstElementChild;
      hand.addEventListener('click', ev => {
        const placeIdx = parseInt(hand.dataset.placeIdx, 10);
        placePromiseResolve(placeIdx);
      }, false);
    }

    for (let hand of this.me.hands.children) {
      hand.addEventListener('click', ev => {
        if (hand.dataset.color != 'undefined') {
          const handIdx = parseInt(hand.dataset.handIdx, 10);
          handPromiseResolve(handIdx, hand.dataset.color);
        }
      }, false);
    }

    for (let hand of this.islander.hands.children) {
      hand.addEventListener('click', ev => {
        if (hand.dataset.color != 'undefined') {
          const handIdx = parseInt(hand.dataset.handIdx, 10);
          handPromiseResolve(handIdx, hand.dataset.color);
        }
      }, false);
    }
  }

  get controller() {
    return this.sessionManager.current;
  }
}

View.singleSeatRoomManagerFactory = function (defaultPlayerAFactory) {
  return new roomManager.SingleSeatRoomManager(defaultPlayerAFactory);
};

View.singleSeatPlayerManagerFactory = function () {
  return new roomManager.SingleSeatPlayerManager();
};
