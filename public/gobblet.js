import { assert, assertNot, randomUnder, randomId, delay, itemAt } from './util.js';

const gameSetting3 = {
  boardSize: 3,
  hands: '112233',
  maxPower: 3,
  stackRules: false,
  loseWithNoHands: false,
  stepLimit: 50,
};

const gameSetting4 = {
  boardSize: 4,
  hands: '444',
  maxPower: 4,
  stackRules: true,
  loseWithNoHands: false,
  stepLimit: 50,
};

export const GobbletSetting = {
  boardSize3:  Symbol('BoardSize3'),
  boardSize4:  Symbol('BoardSize4'),
  orderFirst:  Symbol('OrderFirst'),
  orderSecond: Symbol('OrderSecond'),
  fromString(str) {
    if (str == this.boardSize3.toString()) {
      return this.boardSize3;
    } else if (str == this.boardSize4.toString()) {
      return this.boardSize4;
    } else if (str == this.orderFirst.toString()) {
      return this.orderSize3;
    } else if (str == this.orderSecond.toString()) {
      return this.orderSize4;
    }
    return undefined;
  },
};

export class NoRoomError extends Error {
  constructor(roomId) {
    super();
    this.roomId = roomId;
  }
}
export class RoomFullError extends Error { }
export class LeaveRoomError extends Error { }

export class GameExceptionError extends Error {
  constructor(name) {
    super(name);
  }
}
export class LeaveException extends GameExceptionError {
  constructor(color) {
    super('leave');
    this.color = color;
  }
}

export class WaitTimeoutException extends GameExceptionError {
  constructor(color) {
    super('wait-timeout');
    this.color = color;
  }
}

export class StepLimitException extends GameExceptionError {
  constructor() {
    super('step-limit');
  }
}

export class RuleError extends Error {
  constructor(ruleId) {
    super(ruleId);
    this.ruleId = ruleId;
  }
}

function ruleAssert(cond, msgId) {
  if (!cond) throw new RuleError(msgId);
}

function ruleAssertNot(cond, msgId) {
  if (cond) throw new RuleError(msgId);
}

export function assertRules(step, player, board) {
  const { handFrom, handIdx, placeIdx } = step;
  assert((handFrom == 'hand') || (handFrom == 'board'), 'hand-from-void');

  const hands = (handFrom == 'hand') ? player.hands : board;

  assert((handIdx >= 0) && (handIdx < hands.length), 'invaild-hand');
  const handStack = hands[handIdx];

  // stack index 0 is placeholder.
  assert(handStack.length > 1, 'empty-hand-stack');
  const hand = itemAt(handStack, -1);

  assert((placeIdx >= 0) && (placeIdx < board.length), 'invaild-place');
  const placeStack = board[placeIdx];

  // should always pass because we have a placeholder.
  assert(placeStack.length > 0, 'placeholder-goes-1');
  const place = itemAt(placeStack, -1);

  console.log('from:', handFrom, 'hand:', hand, 'place:', place);

  assert(hand.color == player.color, 'not-player-hand');

  ruleAssertNot(((handFrom == 'board') && (placeIdx == handIdx)), 'place-same-place');
  ruleAssert(place.color != hand.color, 'place-same-color');
  // can move hand https://www.ultraboardgames.com/gobblet/game-rules.php
  //ruleAssertNot(((handFrom == 'board') && (!place.color)), 'no-move-hand');
  ruleAssert(place.power < hand.power, 'place-less-power');

  return { handFrom, handStack, hand, placeStack, place };
}

export function detectWinner(gameSetting, winPatterns, playerA, playerB, board) {
  // someone lose if he not have any hand.
  if (gameSetting.loseWithNoHands) {
    const hasNoHandA = playerA.hands.every(hand => !itemAt(hand, -1).color);
    const hasNoHandB = playerB.hands.every(hand => !itemAt(hand, -1).color);
    if (hasNoHandA) {
      return { color: playerB.color, reason: 'no-more-hand' };
    } else if (hasNoHandB) {
      return { color: playerA.color, reason: 'no-more-hand' };
    }
  }

  // find all filled line.
  const filledLines = [];
  for (let pattern of winPatterns) {
    const values = pattern.map(i => itemAt(board[i], -1).color);
    const aColor = values[0];
    if (values.every(b => ((b) && (b == aColor)))) {
      filledLines.push({ color: aColor, pattern });
    }
  }

  if (filledLines.length == 0) {
    // if no more empty place, draw game.
//      const haveEmptyPlace = board.find(stack => !itemAt(stack, -1).color);
//      if (!haveEmptyPlace) {
//        return { color: 'draw', reason: 'no-more-place' };
//      }
    // just no one filled, continue.
//      else {
      return undefined;
//      }
  }

  // if two player filled, draw game.
  const aWinnerColor = filledLines[0].color;
  const twoPlayerFilled = filledLines.find(({color}) => color != aWinnerColor);
  if (twoPlayerFilled) {
    return { color: 'draw', reason: 'two-player-filled', filledLines };
  }
  // only have one winner.
  else {
    return { color: aWinnerColor, reason: 'player-filled', filledLines };
  }
}

export class Gobblet {
  constructor(room) {
    this._setting = undefined;
    this._winPatterns = undefined;

    this.boardCommits = undefined;

    this.room = undefined;

    this.board = undefined;

    this.playerA = undefined;
    this.playerB = undefined;
  }

  newGame(room) {
    const { boardSize, ownerFirst, myRoom, viewMode } = room;

    this.boardCommits = [];
    this.room = room;

    this.setBoardSize(boardSize);
    this.board = Array.from(Array(this.boardSize), (i, idx) => {
      return [{ idx, power: 0, color: undefined }];
    });

    const powerToHandStackFn = (color) => {
      return (power, idx) => {
        const stack = [{ idx, power: 0, color: undefined }];
        power = parseInt(power, 10);
        for (let i = this.stackRules ? 1 : power; i <= power; ++i) {
          stack.push({ idx, power: i, color });
        }
        return stack;
      };
    }

    const playerAFirst = ((myRoom && ownerFirst) || (!myRoom && !ownerFirst));
    const [colorA, colorB] = ((viewMode) || (playerAFirst)) ? ['red', 'blue'] : ['blue', 'red'];

    this.playerA = {
      color: colorA,
      hands: Array.from(this._setting.hands, powerToHandStackFn(colorA)),
    };

    this.playerB = {
      color: colorB,
      hands: Array.from(this._setting.hands, powerToHandStackFn(colorB)),
    };

    // for debugging
    const firstCommit = {
      act: 'game-setting',
      boardSize: this._setting.boardSize, ownerFirst,
    };
    this.boardCommits.push(firstCommit);
  }

  performStep(step, player) {
    const { handFrom, handStack, hand, placeStack, place } = assertRules(step, player, this.board);

    // pop a hand and move to place.
    const pop = handStack.pop();
    pop.idx = place.idx;
    placeStack.push(pop);

    // we still have placeholder.
    assert(handStack.length > 0, 'placeholder-goes-2');
    assert(placeStack.length > 0, 'placeholder-goes-3');

    // revert the last form hand stack.
    const revert = itemAt(handStack, -1);

    const commits = [
      { ...revert, act: 'pop',  playerColor: player.color, handFrom },
      { ...pop,    act: 'push', playerColor: player.color },
    ];

    this.boardCommits.push(...commits);

    console.log('result:', commits);
    //console.log(this.board);

    return commits;
  }

  setBoardSize(boardSize) {
    assert((boardSize == GobbletSetting.boardSize3) || (boardSize == GobbletSetting.boardSize4));

    const setting = (boardSize == GobbletSetting.boardSize3) ? gameSetting3 : gameSetting4;
    this._setting = setting;

    function range(i, l, s) {
      return Array.from(Array(l), (_, j) => i + j * s);
    }
    this._winPatterns = [];
    // h
    for (let i = 0; i < setting.boardSize; ++i) {
      this._winPatterns.push(range(i * setting.boardSize, setting.boardSize, 1));
    }
    // v
    for (let i = 0; i < setting.boardSize; ++i) {
      this._winPatterns.push(range(i, setting.boardSize, setting.boardSize));
    }
    // n
    this._winPatterns.push(range(0, setting.boardSize, setting.boardSize + 1));
    this._winPatterns.push(range(setting.boardSize - 1, setting.boardSize, setting.boardSize - 1));

    //console.log(this._winPatterns);
  }

  detectWinner() {
    return detectWinner(this, this._winPatterns, this.playerA, this.playerB, this.board);
  }

  get boardSize() {
    return this._setting.boardSize ** 2;
  }

  get winPatterns() {
    return this._winPatterns;
  }

  get maxPower() {
    return this._setting.maxPower;
  }

  get stackRules() {
    return this._setting.stackRules;
  }

  get loseWithNoHands() {
    return this._setting.loseWithNoHands;
  }

  get reachStepLimit() {
    const stepCount = (this.boardCommits.length - 1) / 2;
    return (stepCount > this._setting.stepLimit);
  }
}
