import { GobbletSetting, NoRoomError, LeaveRoomError } from './gobblet.js';
import { assert, assertNot, randomUnder, randomId, delay, itemAt } from './util.js';

export class LocalRoomManager {
  constructor(defaultPlayerAFactory) {
    this.defaultPlayerAFactory = defaultPlayerAFactory;
    this.room = undefined;
  }

  async createRoom(preferSetting) {
    const boardSize  = (preferSetting.boardSize == GobbletSetting.boardSize3) ?
      GobbletSetting.boardSize3 : GobbletSetting.boardSize4;
    const ownerFirst = (preferSetting.order == GobbletSetting.orderFirst);
    this.room = {
      id: `local-${randomId(8)}`,
      boardSize, ownerFirst,
      privateRoom: true,
      createTime: new Date(),
      joinTime: new Date(),
      endTime: null,
      myRoom: true,
      viewMode: false,
      localCreateTime: new Date(),
      localJoinTime: new Date(),
    };
    return this.room;
  }

  async waitForPlayerJoin() {
    return this.room;
  }

  async attachPublicRoom(preferSetting) {
    return undefined;
  }

  async attachRoom(roomId) {
    throw new NoRoomError();
  }

  async joinRoom() {
    throw new NoRoomError();
  }

  async viewRoom() {
    throw new NoRoomError();
  }

  async detachRoom() {
    console.info('{ local-room } room detach');
    this.room = undefined;
  }

  async endRoom() {
    console.info('{ local-room } room end');
    this.room = undefined;
  }

  async endRoomWithException(exception) {
    console.info('{ local-room } exception:', exception);
    this.room = undefined;
  }

  async stopMatchRoom() {
    this.room = undefined;
  }

  async sendException(exception) {
    // pass
  }

  getPlayerAManager() {
    return this.defaultPlayerAFactory();
  }

  getPlayerBManager() {
    throw new Error('should not instance LocalRoomManager');
  }
}

export class ShowRoomManager extends LocalRoomManager {
  constructor(defaultPlayerAFactory) {
    super(defaultPlayerAFactory);
  }

  getPlayerAManager() {
    return new RandomPlayerManager();
  }

  getPlayerBManager() {
    return new RandomPlayerManager();
  }
}

export class RandomRoomManager extends LocalRoomManager {
  constructor(defaultPlayerAFactory) {
    super(defaultPlayerAFactory);
  }

  getPlayerBManager() {
    return new RandomPlayerManager();
  }
}

export function randomRoomManagerFactory(defaultPlayerAFactory) {
  return new RandomRoomManager(defaultPlayerAFactory);
}

export function showRoomManagerFactory(defaultPlayerAFactory) {
  return new ShowRoomManager(defaultPlayerAFactory);
}

export class RandomPlayerManager {
  async recvStep(step) {
    // pass
  }

  async getStep(controller) {
    const board = controller.board.map(stack => itemAt(stack, -1));
    const player = {
      color: controller.player.color,
      hands: controller.player.hands.map(stack => itemAt(stack, -1)),
    };
    const step = this.randomHand(board, player);
    if (!step) {
      return undefined;
    }

    const { color, handFrom, hand, place } = step;
    await controller.onWaiting();

    await controller.onSelectPhase();
    await controller.onSelectedHand(handFrom, hand.idx);
    await delay(500);

    await controller.onPlacePhase();
    await controller.onSelectedHand('board', place.idx);
    await delay(500);

    await controller.onWaitingEnd();

    return { color, handFrom, handIdx: hand.idx, placeIdx: place.idx };
  }

  randomHand(board, player) {
    const color = player.color;

    const selfHands = player.hands.filter(hand => hand.color);
    //assert(selfHands.length > 0); // obey loseWithNoHands.
    console.log('::selfHands:', selfHands);

    const selfPlaces = board.filter(place => place.color == player.color);
    console.log('::selfPlaces:', selfPlaces);

    const notSelfPlaces = board.filter(place => place.color != player.color);
    console.log('::notSelfPlaces:', notSelfPlaces);

    const oppositePlaces = board.filter(place => ((place.color) && (place.color != player.color)));
    console.log('::oppositePlaces:', oppositePlaces);

    const emptyPlaces = board.filter(place => !place.color);
    console.log('::emptyPlaces:', emptyPlaces);

    // find a hand from all myself
    const vaildHands = selfHands.concat(selfPlaces);
    let tmphandIdx = randomUnder(vaildHands.length);
    let hand = vaildHands[tmphandIdx];

    const handFrom = (tmphandIdx >= selfHands.length) ? 'board' : 'hand';

    console.log('++find a hand from:', handFrom, ':', { ...hand });

    // find a place
    const possiblePlaces = (handFrom == 'hand') ? notSelfPlaces : oppositePlaces;
    let tmpPlaceIdx = randomUnder(possiblePlaces.length);
    let place = possiblePlaces[tmpPlaceIdx];
    console.log('++find somewhere:', { ...place });

    // found a empty place, place to it
    if (!place.color) {
      console.log('++found a empty place');
      return { color, handFrom, hand, place };
    } else if (hand.power > place.power) {
      console.log('++not empty place but we have power');
      return { color, handFrom, hand, place };
    }

    // not empty, find a bigger hand
    console.log('++not empty, find bigger hands');
    const biggerHands = selfHands.find(hand => hand.power > place.power);
    console.log('::biggerHands:', biggerHands);

    const biggerPlace = selfPlaces.find(hand => hand.power > place.power);
    console.log('::biggerPlace:', biggerPlace);

    if (biggerHands) {
      console.log('++found a bigger hand', { ...biggerHands });
      return { color, handFrom: 'hand', hand: biggerHands, place };
    } else if (biggerPlace) {
      console.log('++found a bigger hand on the board', { ...biggerPlace });
      return { color, handFrom: 'board', hand: biggerPlace, place };
    }

    // no biger hand and no more on hands
    if (selfHands.length == 0) {
      throw new LeaveRoomError();
    }

    // no bigger hand, find a hand from hand and place to some empty place
    console.log('++no bigger hand, place to some empty places');

    tmphandIdx = randomUnder(selfHands.length);
    hand = vaildHands[tmphandIdx];

    tmpPlaceIdx = randomUnder(emptyPlaces.length);
    place = emptyPlaces[tmpPlaceIdx];

    return { color, handFrom: 'hand', hand, place };
  }
}
