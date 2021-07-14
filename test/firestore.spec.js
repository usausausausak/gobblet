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
  it('only write inside public and private', async () => {
    const db = getFirestore();

    await firebase.assertSucceeds(db.collection('public').add({ joinTime: null, endTime: null }));
    await firebase.assertSucceeds(db.collection('private').add({ joinTime: null, endTime: null }));
    await firebase.assertFails(db.collection('something').add({ joinTime: null, endTime: null }));
    await firebase.assertFails(db.collection('something').doc('bob').set({ joinTime: null, endTime: null }));
    await firebase.assertFails(db.collection('something').doc('bob').update({ joinTime: null, endTime: null }));
  });

  for (let kind of ['public', 'private']) {
    it(`create ${kind} room`, async () => {
      const db = getFirestore();
      const room = await db.collection(kind);

      await firebase.assertSucceeds(room.add({ joinTime: null, endTime: null }));
      await firebase.assertFails(room.add({ joinTime: firebase.firestore.FieldValue.serverTimestamp() }));
      await firebase.assertFails(room.add({ endTime: firebase.firestore.FieldValue.serverTimestamp() }));
    });

    it(`join ${kind} room`, async () => {
      const db = getFirestore();
      const doc = await db.collection(kind).add({ joinTime: null, endTime: null });

      await firebase.assertSucceeds(doc.update({ joinTime: firebase.firestore.FieldValue.serverTimestamp() }));
      await firebase.assertFails(doc.update({ joinTime: firebase.firestore.FieldValue.serverTimestamp() }));
    });

    it(`update ${kind} room`, async () => {
      const db = getFirestore();
      const doc = await db.collection(kind).add({ joinTime: null, endTime: null });
      doc.update({ joinTime: firebase.firestore.FieldValue.serverTimestamp() });

      await firebase.assertFails(doc.update({ joinTime: firebase.firestore.FieldValue.serverTimestamp() }));

      await firebase.assertSucceeds(doc.update({ endTime: firebase.firestore.FieldValue.serverTimestamp() }));
      await firebase.assertSucceeds(doc.update({ joinTime: null, endTime: null }));
    });

    it(`should not delete ${kind} room`, async () => {
      const db = getFirestore();
      const doc = await db.collection(kind).add({ joinTime: null, endTime: null });

      await firebase.assertFails(doc.delete());
    });

    it(`stop match ${kind} room`, async () => {
      const db = getFirestore();
      const doc = await db.collection(kind).add({ joinTime: null, endTime: null });

      await firebase.assertSucceeds(doc.update({ endTime: firebase.firestore.FieldValue.serverTimestamp() }));
      await firebase.assertFails(doc.update({ endTime: firebase.firestore.FieldValue.serverTimestamp() }));
    });

    it(`can write exception in ${kind} room`, async () => {
      const db = getFirestore();
      const ref = await db.collection(kind).add({ joinTime: null, endTime: null });
      const steps = ref.collection('step');

      await firebase.assertSucceeds(steps.doc('exception').set({  }));
      await firebase.assertSucceeds(steps.doc('exception').update({  }));
      await firebase.assertFails(steps.doc('exception').delete({  }));
    });

    it(`should not update step in ${kind} room`, async () => {
      const db = getFirestore();
      const ref = await db.collection(kind).add({ joinTime: null, endTime: null });
      const doc = ref.collection('step').doc('step');

      await firebase.assertSucceeds(doc.set({  }));
      await firebase.assertFails(doc.update({  }));
      await firebase.assertFails(doc.delete());
    });
  }
});
