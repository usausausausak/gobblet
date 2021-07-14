import * as firebase from  '@firebase/rules-unit-testing';
import fs from 'fs';

const projectId = 'gobblet-test';
const coverageUrl = `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}:ruleCoverage.html`;

/**
 * Creates a new client FirebaseApp with authentication and returns the Firestore instance.
 */
function getFirestore(auth) {
  return firebase
    .initializeTestApp({ projectId, auth: null })
    .firestore();
}

function timestamp() {
  return firebase.firestore.FieldValue.serverTimestamp();
}

function newDummyRoom(privateRoom) {
  return { joinTime: null, endTime: null, privateRoom: !!privateRoom };
}

function nullPlayerManagerFactory() {
  return undefined;
}

beforeEach(async () => {
  // Clear the database between tests
  await firebase.clearFirestoreData({ projectId });
});

before(async () => {
  // Load the rules file before the tests begin
  const rules = fs.readFileSync("firestore.rules", "utf8");
  await firebase.loadFirestoreRules({ projectId, rules });
});

after(async () => {
  // Delete all the FirebaseApp instances created during testing
  // Note: this does not affect or clear any data
  await Promise.all(firebase.apps().map((app) => app.delete()));
});

describe('gobblet', () => {
  it('should not read outside public and private', async () => {
    const db = getFirestore();
    await firebase.assertFails(db.collection('something').doc('bob').get());
  });

  it('should not write outside public and private', async () => {
    const db = getFirestore();

    await firebase.assertFails(db.collection('something').add(newDummyRoom()));
    await firebase.assertFails(db.collection('something').add(newDummyRoom(true)));
    await firebase.assertFails(db.collection('something').doc('bob').set(newDummyRoom()));
    await firebase.assertFails(db.collection('something').doc('bob').update(newDummyRoom()));
  });

  for (let kind of ['public', 'private']) {
    const privateRoom = (kind == 'private');
    const dummyRoom = newDummyRoom(privateRoom);
    it(`create ${kind} room`, async () => {
      const db = getFirestore();
      const roomsRef = db.collection(kind);

      await firebase.assertSucceeds(roomsRef.add(dummyRoom));
      await firebase.assertFails(roomsRef.add({ joinTime: timestamp() }));
      await firebase.assertFails(roomsRef.add({ endTime: timestamp() }));
    });

    it(`join ${kind} room`, async () => {
      const db = getFirestore();
      const room = await db.collection(kind).add(dummyRoom);

      await firebase.assertSucceeds(room.update({ joinTime: timestamp() }));
      await firebase.assertFails(room.update({ joinTime: timestamp() }));
    });

    it(`end ${kind} room`, async () => {
      const db = getFirestore();
      const room = await db.collection(kind).add(dummyRoom);
      room.update({ joinTime: timestamp() });

      await firebase.assertSucceeds(room.update({ endTime: timestamp() }));
    });

    it(`should not join and end a ended ${kind} room`, async () => {
      const db = getFirestore();
      const room = await db.collection(kind).add(dummyRoom);
      room.update({ endTime: timestamp() });

      await firebase.assertFails(room.update({ joinTime: timestamp() }));
      await firebase.assertFails(room.update({ endTime: timestamp() }));
    });

    it(`should not delete ${kind} room`, async () => {
      const db = getFirestore();
      const room = await db.collection(kind).add(dummyRoom);

      await firebase.assertFails(room.delete());
    });

    it(`stop match ${kind} room`, async () => {
      const db = getFirestore();
      const room = await db.collection(kind).add(dummyRoom);

      await firebase.assertSucceeds(room.update({ endTime: timestamp() }));
      await firebase.assertFails(room.update({ endTime: timestamp() }));
    });

    it(`should not create opposite room in ${kind} coolection`, async () => {
      const db = getFirestore();
      const roomsRef = db.collection(kind);

      await firebase.assertFails(roomsRef.add(newDummyRoom(!privateRoom)));
    });

    it(`listening ${kind} room`, async () => {
      const db = getFirestore();
      const room = await db.collection(kind).add(dummyRoom);
      const stepsRef = room.collection('steps-1');

      const unsubscribe = await firebase.assertSucceeds(stepsRef.onSnapshot(() => {}));
      await firebase.assertSucceeds(unsubscribe());
    });

    it(`create step and exception in ${kind} room`, async () => {
      const db = getFirestore();
      const room = await db.collection(kind).add(dummyRoom);
      const stepsRef = room.collection('steps-1');

      await firebase.assertSucceeds(stepsRef.doc('step-1').set({  }));
      await firebase.assertSucceeds(stepsRef.doc('exception').set({  }));
    });

    it(`should not update step in ${kind} room`, async () => {
      const db = getFirestore();
      const room = await db.collection(kind).add(dummyRoom);
      const step = room.collection('steps-1').doc('step-1');
      await step.set({  });

      await firebase.assertFails(step.update({  }));
    });

    it(`update exception in ${kind} room`, async () => {
      const db = getFirestore();
      const room = await db.collection(kind).add(dummyRoom);
      const exception = room.collection('steps-1').doc('exception');
      await exception.set({  });

      await firebase.assertSucceeds(exception.update({  }));
    });

    it(`should not delete step and exception in ${kind} room`, async () => {
      const db = getFirestore();
      const room = await db.collection(kind).add(dummyRoom);
      const stepsRef = room.collection('steps-1');
      const step = stepsRef.doc('step-1');
      await step.set({ });
      const exception = stepsRef.doc('exception');
      await exception.set({ });

      await firebase.assertFails(step.delete());
      await firebase.assertFails(exception.delete());
    });

    it(`should not write step and exception in not exist ${kind} room`, async () => {
      const db = getFirestore();
      const room = await db.collection(kind).add(dummyRoom);
      const doc = room.collection('steps-1').doc('step-1');

      await firebase.assertSucceeds(doc.set({  }));
      await firebase.assertFails(doc.update({  }));
      await firebase.assertFails(doc.delete());
    });
  }

  it(`should not update public room`, async () => {
    const db = getFirestore();
    const room = await db.collection('public').add(newDummyRoom());
    room.update({ joinTime: timestamp(), endTime: timestamp() });

    await firebase.assertFails(room.update({ joinTime: null, endTime: null }));
  });

  it(`update private room`, async () => {
    const db = getFirestore();
    const room = await db.collection('private').add(newDummyRoom(true));
    room.update({ joinTime: timestamp(), endTime: timestamp() });

    await firebase.assertSucceeds(room.update({ joinTime: null, endTime: null }));
  });
});
