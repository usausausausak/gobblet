import { Gobblet, GobbletSetting } from './gobblet.js';
import { Contoller } from './controller.js';
import { SessionManager } from './session.js';
import { View } from './view.js';
import { remoteRoomManagerFactory } from './firestore-room-manager.js';
import { randomRoomManagerFactory, showRoomManagerFactory } from './local-room-manager.js';
import { NamedPromise } from './util.js';

function fmtString(msg, fmtArgs) {
  for (let [key, value] of Object.entries(fmtArgs)) {
    msg = msg.replace(`{${key}}`, value);
  }
  return msg;
}

View.prototype.getString = function (msgId, fmtArgs) {
  const stringSet = document.getElementById('string-set').content;
  const string = stringSet.getElementById(msgId);

  if (string) {
    return (fmtArgs) ? fmtString(string.textContent, fmtArgs) : string.textContent;
  } else {
    return msgId;
  }
}

View.prototype.getPreferSetting = function () {
  const preferSize3 = document.getElementById('prefer-size3').classList.contains('radio-checked');
  const preferFirst = document.getElementById('prefer-first').classList.contains('radio-checked');
  return {
    boardSize: (preferSize3) ? GobbletSetting.boardSize3 : GobbletSetting.boardSize4,
    order:     (preferFirst) ? GobbletSetting.orderFirst : GobbletSetting.orderSecond,
    privateRoom: false,
  };
}

View.prototype.initNavMatchEvents = function () {
  this.sessionManager.setMyManagerFactory(View.singleSeatPlayerManagerFactory);

  // match settings
  const radioClick = (ev) => {
    let button = ev.target;
    while (!button.matches('.radio')) {
      button = button.parentElement;
    }

    const box = button.parentElement;

    box.querySelectorAll('.radio').forEach(el => el.classList.remove('radio-checked'));
    button.classList.add('radio-checked');
  };

  document.querySelectorAll('.radio').forEach(el => el.addEventListener('click', radioClick));

  // match buttons
  const matches = {
    'match':    remoteRoomManagerFactory,
    'private':  remoteRoomManagerFactory,
    'random':   randomRoomManagerFactory,
    'one-seat': View.singleSeatRoomManagerFactory,
    'show':     showRoomManagerFactory,
  };

  for (let [key, factory] of Object.entries(matches)) {
    const privateRoom = (key == 'private');
    const match = document.getElementById(`match-${key}`);
    match.addEventListener('click', () => {
      this.sessionManager.setRoomManagerFactory(factory);
      const setting = this.getPreferSetting();
      setting.privateRoom = privateRoom;
      this.sessionManager.match(setting);
    });
  }

  const newGame = document.getElementById('new-game');
  newGame.addEventListener('click', () => this.sessionManager.acceptOtherPlayer());
}

View.prototype.initNavEvents = function () {
  const backFn    = (ev) => history.back();
  const stopFn    = (ev) => NamedPromise.resolve('SessionPromise', true);
  const messageFn = (ev) => NamedPromise.resolve('MessagePromise', ev.target.dataset.answer == 'yes');

  document.querySelectorAll('.back-button')
    .forEach(button => button.addEventListener('click', backFn));

  document.querySelectorAll('.message-button')
    .forEach(button => button.addEventListener('click', messageFn));

  const buttons = [
    // nav buttons
    { id: 'rules',        fn: () => this.changePage({ pageId: 'rules', newPage: true }) },
    // stop buttons
    { id: 'room',         fn: stopFn },
    { id: 'stop-match',   fn: stopFn },
  ];

  for (let { id, fn } of buttons) {
    const button = document.getElementById(id);
    button.addEventListener('click', fn);
  }

  this.initNavMatchEvents();

  // browser action
  //window.addEventListener('popstate', (ev) => this.popNavState(ev.state));
  window.addEventListener('popstate', () => this.goPageByHash());
}

View.prototype.beforeNavLeavePage = function (state) {
  // TODO: do not use private variable

  if (this.controller.running) {
    const room = this.controller.room;
    if (room) {
      history.pushState({ ...state, room: 'something true' }, '', `#${room.id}`);
    }

    return false;
  } else {
    return true;
  }
}

View.prototype.beforeNavPage = function () {
  // TODO: handle better
  // eat using promises.
   NamedPromise.cancel('MessagePromise');
  NamedPromise.resolve('SessionPromise', true);
}

View.prototype.popNavState = function (state) {
  console.log(document.location)
  console.log(history.state)
  console.log(state)
}

View.prototype.changePage = function (pageId) {
  const state = (pageId.pageId) ? pageId : { pageId };
  //console.log('changePage:', history.state)

  switch (state.pageId) {
    case 'choose':
      //history.replaceState(undefined, '', '/');
      //document.body.dataset.page = 'choose';
      //window.scrollTo(0, 0);
      // should have a page
      history.back();
      break;
    case 'rules':
      if (state.newPage) {
        delete state.newPage;
        history.pushState(state, '', '#rules')
      } else {
        history.replaceState(state, '', '#rules');
      }
      document.body.dataset.page = state.pageId;
      window.scrollTo(0, 0);
      break;
    case 'match':
      if (state.room) {
        history.replaceState(state, '', `#${state.room.id}`);
      } else if (state.newPage) {
        delete state.newPage;
        history.pushState({ ...state, room: undefined }, '', '#match')
      } else {
        history.replaceState(state, '', '/');
      }
      document.body.dataset.page = state.pageId;
      break;
    case 'result':
    case 'playend':
    case 'error':
      document.body.dataset.page = state.pageId;
      break;
    default:
      document.body.dataset.page = 'main';
      break;
  }
}

View.prototype.startNewPage = function (state) {
  if (!state) {
    history.replaceState(undefined, '', '/');
    document.body.dataset.page = 'choose';
    window.scrollTo(0, 0);
    return;
  }

  switch (state.pageId) {
    case 'choose':
    case 'result':
    case 'playend':
    case 'error':
      // should not go directly.
      history.replaceState(undefined, '', '/');
      document.body.dataset.page = 'choose';
      window.scrollTo(0, 0);
      break;
    case 'rules':
      this.changePage(state);
      break;
    case 'match':
      // should not go directly.
      history.replaceState(undefined, '', '/');
      document.body.dataset.page = 'choose';
      window.scrollTo(0, 0);
      break;
    default:
      if (state.room) {
        // should not go again.
        history.replaceState(undefined, '', '/');
        document.body.dataset.page = 'choose';
        window.scrollTo(0, 0);
      } else {
        history.replaceState(undefined, '', '/');
        this.sessionManager.setMyManagerFactory(View.singleSeatPlayerManagerFactory);
        this.sessionManager.setRoomManagerFactory(remoteRoomManagerFactory);
        this.sessionManager.match({ roomId: state.pageId });
      }
      break;
  }
}

View.prototype.hashToState = function (hash) {
  hash = hash ? hash : location.hash.substr(1);

  switch (hash) {
    case 'rules':
      return { pageId: 'rules' };
    case 'result':
    case 'playend':
    case 'error':
      return { pageId: hash };
    case 'match':
      return { pageId: 'match', room: undefined };
    case 'choose':
    case '':
      return { pageId: 'choose' };
    default:
      // go to room id
      return { pageId: hash };
  }
}

View.prototype.goPageByHash = function (hash) {
  const state = (history.state) ? history.state : this.hashToState(hash);
  console.log('goPageByHash', state, history.state);

  this.beforeNavPage();
  // leave matched or playing room
  if (!this.beforeNavLeavePage()) {
    return;
  }

  document.body.classList.remove('loading');
  this.startNewPage(state);
}


View.prototype.startNav = function () {
  const hash = document.location.hash.substr(1);
  const state = this.hashToState(hash);

  document.body.classList.remove('loading');
  this.startNewPage(state);
}

window.addEventListener('DOMContentLoaded', () => {
  const sessionManager = new SessionManager(() => new Gobblet());
  const view = new View(sessionManager);
});
