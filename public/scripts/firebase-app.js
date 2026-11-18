import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js';

// Firebase Hosting and its local emulator supply the project's web config.
const response = await fetch('/__/firebase/init.json');
if (!response.ok) {
    throw new Error('Firebase config unavailable. Start the Firebase Hosting emulator.');
}
export const config = await response.json();
if (config.projectId !== 'shanetuffproject' || !config.apiKey || !config.appId) {
    throw new Error('Expected Firebase Hosting configuration for shanetuffproject.');
}
export const app = initializeApp(config);
