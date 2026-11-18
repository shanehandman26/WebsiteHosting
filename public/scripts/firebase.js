import { app } from './firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js';
import { getFirestore, doc, getDoc, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js';

const auth = getAuth(app);
const db = getFirestore(app);
await auth.authStateReady();
const user = auth.currentUser || (await signInAnonymously(auth)).user;
const player = doc(db, 'players', user.uid);

export async function loadBestScore() {
    const snapshot = await getDoc(player);
    return snapshot.exists() ? snapshot.data().bestScore : 0;
}

export async function saveBestScore(score) {
    if (!Number.isInteger(score) || score < 0 || score > 6) {
        throw new Error('Score must be an integer between 0 and 6.');
    }
    // A second tab or a later, slower request must never lower the best score.
    return runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(player);
        const bestScore = Math.max(score, snapshot.exists() ? snapshot.data().bestScore : 0);
        if (!snapshot.exists() || bestScore > snapshot.data().bestScore) {
            transaction.set(player, { bestScore, updatedAt: serverTimestamp() });
        }
        return bestScore;
    });
}
