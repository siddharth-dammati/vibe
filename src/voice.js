import { database, ref, set, onChildAdded, onValue, remove, push, onDisconnect } from './firebase.js';

let localStream = null;
let peerConnections = {}; // targetUid -> RTCPeerConnection
let roomId = null;
let currentUid = null;
let isMuted = false;

const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// Listeners for UI
let onParticipantUpdated = null; // (uid, isTalking/isMuted) => void

export async function joinVoice(room, uid, onParticipantChange) {
  roomId = room;
  currentUid = uid;
  onParticipantUpdated = onParticipantChange;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    console.error("Error accessing microphone", err);
    alert("Could not access microphone.");
    return false;
  }

  // Set presence in Firebase
  const myPresenceRef = ref(database, `rooms/${roomId}/voice_participants/${currentUid}`);
  await set(myPresenceRef, { joinedAt: Date.now(), isMuted: false });
  onDisconnect(myPresenceRef).remove();

  // Listen for others joining
  const participantsRef = ref(database, `rooms/${roomId}/voice_participants`);
  onChildAdded(participantsRef, snapshot => {
    const targetUid = snapshot.key;
    // Tie-breaker to prevent glare: only the user with the strictly greater UID initiates the offer
    if (targetUid !== currentUid && currentUid > targetUid) {
      createOffer(targetUid);
    }
  });

  onValue(participantsRef, snapshot => {
    // Handle changes (mute/unmute or leaves)
    const data = snapshot.val() || {};
    // Clean up connections if they left
    Object.keys(peerConnections).forEach(pUid => {
      if (!data[pUid]) {
        peerConnections[pUid].close();
        delete peerConnections[pUid];
        removeAudioElement(pUid);
      }
    });
    // Notify UI of state changes
    Object.keys(data).forEach(pUid => {
      if (onParticipantUpdated) {
        onParticipantUpdated(pUid, data[pUid]);
      }
    });
  });

  // Listen for incoming offers
  const offersRef = ref(database, `rooms/${roomId}/webrtc/offers/${currentUid}`);
  onChildAdded(offersRef, snapshot => {
    const data = snapshot.val();
    handleOffer(data.sender, data.offer);
    remove(ref(database, `rooms/${roomId}/webrtc/offers/${currentUid}/${snapshot.key}`)); // cleanup
  });

  // Listen for incoming answers
  const answersRef = ref(database, `rooms/${roomId}/webrtc/answers/${currentUid}`);
  onChildAdded(answersRef, snapshot => {
    const data = snapshot.val();
    handleAnswer(data.sender, data.answer);
    remove(ref(database, `rooms/${roomId}/webrtc/answers/${currentUid}/${snapshot.key}`)); // cleanup
  });

  // Listen for ICE candidates
  const candidatesRef = ref(database, `rooms/${roomId}/webrtc/candidates/${currentUid}`);
  onChildAdded(candidatesRef, snapshot => {
    const data = snapshot.val();
    handleCandidate(data.sender, data.candidate);
    remove(ref(database, `rooms/${roomId}/webrtc/candidates/${currentUid}/${snapshot.key}`)); // cleanup
  });

  return true;
}

function createPeerConnection(targetUid) {
  if (peerConnections[targetUid]) return peerConnections[targetUid];

  const pc = new RTCPeerConnection(configuration);
  peerConnections[targetUid] = pc;

  // Add local stream tracks
  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  // Handle ICE candidates
  pc.onicecandidate = event => {
    if (event.candidate) {
      const candidatesRef = ref(database, `rooms/${roomId}/webrtc/candidates/${targetUid}`);
      push(candidatesRef, {
        sender: currentUid,
        candidate: event.candidate.toJSON()
      });
    }
  };

  // Handle remote track
  pc.ontrack = event => {
    let audio = document.getElementById(`audio-${targetUid}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio-${targetUid}`;
      audio.autoplay = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = event.streams[0];
  };

  return pc;
}

async function createOffer(targetUid) {
  const pc = createPeerConnection(targetUid);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const offersRef = ref(database, `rooms/${roomId}/webrtc/offers/${targetUid}`);
  push(offersRef, {
    sender: currentUid,
    offer: { type: offer.type, sdp: offer.sdp }
  });
}

let candidateQueues = {};

async function handleOffer(senderUid, offerSdp) {
  const pc = createPeerConnection(senderUid);
  await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
  
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  const answersRef = ref(database, `rooms/${roomId}/webrtc/answers/${senderUid}`);
  push(answersRef, {
    sender: currentUid,
    answer: { type: answer.type, sdp: answer.sdp }
  });
  
  await flushCandidates(senderUid);
}

async function handleAnswer(senderUid, answerSdp) {
  const pc = peerConnections[senderUid];
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
    await flushCandidates(senderUid);
  }
}

async function handleCandidate(senderUid, candidate) {
  const pc = peerConnections[senderUid];
  if (pc && pc.remoteDescription) {
    await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error(e));
  } else {
    if (!candidateQueues[senderUid]) candidateQueues[senderUid] = [];
    candidateQueues[senderUid].push(candidate);
  }
}

async function flushCandidates(senderUid) {
  const pc = peerConnections[senderUid];
  if (pc && candidateQueues[senderUid]) {
    for (let c of candidateQueues[senderUid]) {
      await pc.addIceCandidate(new RTCIceCandidate(c)).catch(e => console.error(e));
    }
    candidateQueues[senderUid] = [];
  }
}

export function leaveVoice() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  Object.keys(peerConnections).forEach(uid => {
    peerConnections[uid].close();
    removeAudioElement(uid);
  });
  peerConnections = {};

  if (currentUid && roomId) {
    const myPresenceRef = ref(database, `rooms/${roomId}/voice_participants/${currentUid}`);
    remove(myPresenceRef);
  }
}

export function toggleMute() {
  if (!localStream) return false;
  
  isMuted = !isMuted;
  localStream.getAudioTracks()[0].enabled = !isMuted;
  
  if (currentUid && roomId) {
    const myPresenceRef = ref(database, `rooms/${roomId}/voice_participants/${currentUid}`);
    set(myPresenceRef, { joinedAt: Date.now(), isMuted: isMuted });
  }
  return isMuted;
}

function removeAudioElement(uid) {
  const el = document.getElementById(`audio-${uid}`);
  if (el) el.remove();
}
