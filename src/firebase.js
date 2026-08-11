import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { getDatabase, ref, set, push, onValue, onDisconnect, remove, get } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyBwIPxrztDeaeJDMQ4FcTSDOYtPqaVXvTY",
  authDomain: "syncbeat-44dba.firebaseapp.com",
  databaseURL: "https://syncbeat-44dba-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "syncbeat-44dba",
  storageBucket: "syncbeat-44dba.firebasestorage.app",
  messagingSenderId: "646484507615",
  appId: "1:646484507615:web:0f84cd3bc384552547a26a",
  measurementId: "G-SDPXEHBC29"
};

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);
const database = getDatabase(app);
const googleProvider = new GoogleAuthProvider();

export {
  app,
  auth,
  database,
  googleProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  ref,
  set,
  push,
  onValue,
  onDisconnect,
  remove,
  get
};
