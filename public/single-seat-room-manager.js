import { LeaveRoomError } from './gobblet.js';
import { LocalRoomManager } from './local-room-manager.js';
import { assert, assertNot, randomId, NamedPromise, itemAt } from './util.js';

export class SingleSeatPlayerManager {
  async recvStep(step) {
    //pass
  }

  async getStep(controller) {
    const selectedStep = { handFrom: undefined, hand: undefined, place: undefined };

    await controller.onSelectPhase();
    let loopingTooMore = 1000;
    while ((!selectedStep.handFrom) || (!selectedStep.hand) || (!selectedStep.place)) {
      if (!loopingTooMore--) {
        break;
      }

      const input = await NamedPromise.create('InputPromise');

      switch (input.clickFrom) {
        case 'hand':
          if (input.color == controller.player.color) {
            await this.clickFromHand(controller, selectedStep, input);
          }
          break;
        case 'board':
          await this.clickFromPlace(controller, selectedStep, input);
          break;
      }
    }

    if (loopingTooMore <= 0) {
      throw new Error('selected too more time, should be a programming error.');
    }

    return {
      color: controller.player.color,
      handFrom: selectedStep.handFrom,
      handIdx: selectedStep.hand.idx,
      placeIdx: selectedStep.place.idx,
    };
  }

  async clickFromHand(controller, selectedStep, input) {
    assert((input.handIdx >= 0) && (input.handIdx < controller.player.hands.length));
    assert(controller.player.color);
    const hand = itemAt(controller.player.hands[input.handIdx], -1);
    assert((hand.power > 0) && (hand.power <= controller.game.maxPower));

    const selectedFrom = selectedStep.handFrom;
    const selectedHand = selectedStep.hand;

    if (selectedHand) {
      selectedStep.handFrom = undefined;
      selectedStep.hand = undefined;

      await controller.onUnselectedHand(selectedFrom, selectedHand.idx);
      await controller.onSelectPhase();
    }

    if ((selectedFrom != 'hand') || (hand.idx != selectedHand.idx)) {
      selectedStep.handFrom = 'hand';
      selectedStep.hand = hand;

      await controller.onSelectedHand(selectedStep.handFrom, selectedStep.hand.idx);
      await controller.onPlacePhase();
    }
  }

  async clickFromPlace(controller, selectedStep, input) {
    assert((input.placeIdx >= 0) && (input.placeIdx < controller.board.length));
    const place = itemAt(controller.board[input.placeIdx], -1);

    const selectedFrom = selectedStep.handFrom;
    const selectedHand = selectedStep.hand;

    const sameColor = place.color == controller.player.color;
    const sameIdx = ((selectedHand) && (place.handIdx == selectedHand.idx));
    // 1. not selected a hand, select hand on the board.
    if (!selectedHand) {
      if (sameColor) {
        selectedStep.handFrom = 'board';
        selectedStep.hand = place;

        await controller.onSelectedHand(selectedStep.handFrom, selectedStep.hand.idx);
        await controller.onPlacePhase();
      }
      // cannot select playerb's hand.
      else {
        // pass
      }
    }
    // 2. selected same hand, unselect.
    else if ((selectedStep.handFrom == 'board') && (sameColor) && (sameIdx)) {
      selectedStep.handFrom = undefined;
      selectedStep.hand = undefined;

      await controller.onUnselectedHand(selectedFrom, selectedHand.idx);
      await controller.onSelectPhase();
    }
    // 3. selected same color, update selected.
    else if (sameColor) {
      selectedStep.handFrom = 'board';
      selectedStep.hand = place;

      await controller.onUnselectedHand(selectedFrom, selectedHand.idx);
      await controller.onSelectedHand(selectedStep.handFrom, selectedStep.hand.idx);
      await controller.onPlacePhase();
    }
    // 4. selected a hand but, warning.
//    else if ((selectedStep.handFrom == 'board') && (!place.color)) {
//      await controller.onWarning('no-move-hand');
//    }
    else if (place.power >= selectedHand.power) {
      await controller.onWarning('place-less-power');
    // 5. selected a hand and not same color, place.
    } else {
      selectedStep.place = place;

      await controller.onSelectedHand('board', selectedStep.place.idx);
    }
  }
}

export class SingleSeatRoomManager extends LocalRoomManager {
  constructor(defaultPlayerAFactory) {
    super(defaultPlayerAFactory);
  }

  getPlayerBManager() {
    return new SingleSeatPlayerManager();
  }
}
