import { auth, database, onAuthStateChanged, ref, set, push, onValue, onDisconnect, remove, get } from './firebase.js';
import { joinVoice, leaveVoice, toggleMute } from './voice.js';

const UI_ICONS = {
  play: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3v18l15-9z"/></svg>`,
  pause: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`,
  heartEmpty: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
  heartFilled: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
  check: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  plus: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`
};

// --- State ---
let currentUser = null;
let currentRoom = new URLSearchParams(window.location.search).get('room') || 'UNKNOWN';
document.getElementById('roomCodeDisplay').innerText = currentRoom;

let queue = [];
let myPlaylist = [];
let nowPlayingIndex = 0;
let myFriends = [];
let activeParticipants = {};
let voiceParticipants = {}; // Track who is in voice chat
let inVoiceChat = false;

let roomState = {
  nowPlayingIndex: 0,
  isPlaying: false,
  seekPosition: 0,
  lastUpdatedAt: Date.now()
};

let serverTimeOffset = 0;
function getServerTime() {
  return Date.now() + serverTimeOffset;
}

// --- Auth Check ---
onAuthStateChanged(auth, (user) => {
  if (user) {
    currentUser = user;
    initRoom();
  } else {
    window.location.href = '/';
  }
});

function initRoom() {
  setupPresence();
  setupFirebaseListeners();
  loadCloudPlaylist();
  loadFriends();

  const initialSongStr = sessionStorage.getItem('jam_initial_song');
  if (initialSongStr) {
    sessionStorage.removeItem('jam_initial_song');
    try {
      const initialSong = JSON.parse(initialSongStr);
      // Wait a tiny bit for queue listeners to attach just in case
      setTimeout(() => addToQueueAndPlay(initialSong), 500);
    } catch (e) {}
  }

  // Request notification permission if not already granted/denied
  const notificationSetup = document.getElementById('notificationSetup');
  
  if (window.Notification && Notification.permission === 'granted') {
    if (notificationSetup) notificationSetup.style.display = 'none';
  } else if (window.Notification && Notification.permission === 'default') {
    // Attempt auto-request on first click anywhere
    const requestOnGesture = () => {
      if (Notification.permission === 'default') {
        Notification.requestPermission().then(updateNotificationUI);
      }
      document.removeEventListener('click', requestOnGesture);
    };
    document.addEventListener('click', requestOnGesture);
  } else if (window.Notification && Notification.permission === 'denied') {
    if (notificationSetup) notificationSetup.style.display = 'none';
  }
}

function updateNotificationUI() {
  const notificationSetup = document.getElementById('notificationSetup');
  if (notificationSetup && window.Notification && Notification.permission !== 'default') {
    notificationSetup.style.display = 'none';
  }
}

// Manual enable notifications button
const enableNotificationsBtn = document.getElementById('enableNotificationsBtn');
if (enableNotificationsBtn) {
  enableNotificationsBtn.addEventListener('click', () => {
    if (window.Notification) {
      Notification.requestPermission().then(updateNotificationUI);
    } else {
      alert("Push notifications are not supported in this browser.");
    }
  });
}

// --- Firebase Sync ---
function setupPresence() {
  const userRef = ref(database, `rooms/${currentRoom}/participants/${currentUser.uid}`);
  const userStatus = {
    name: currentUser.displayName,
    photoURL: currentUser.photoURL,
    status: '🟢 Listening'
  };
  
  set(userRef, userStatus);
  onDisconnect(userRef).remove();
}

let lastLoadedVideoId = null;

function syncPlayerState() {
  if (!isPlayerReady || queue.length === 0 || !queue[nowPlayingIndex]) return;
  
  const currentVideo = queue[nowPlayingIndex];
  updateMiniPlayerUI();
  
  if (lastLoadedVideoId !== currentVideo.videoId) {
    let startSeconds = 0;
    if (roomState.isPlaying) {
      const drift = (getServerTime() - roomState.lastUpdatedAt) / 1000;
      startSeconds = roomState.seekPosition + drift;
    }
    
    if (roomState.isPlaying) {
      player.loadVideoById({ videoId: currentVideo.videoId, startSeconds: startSeconds });
    } else {
      player.cueVideoById({ videoId: currentVideo.videoId, startSeconds: startSeconds });
    }
    lastLoadedVideoId = currentVideo.videoId;
  } else {
    // Song is already loaded, just adjust time/state if needed
    if (roomState.isPlaying) {
      const drift = (getServerTime() - roomState.lastUpdatedAt) / 1000;
      const targetTime = roomState.seekPosition + drift;
      
      // Only seek if we are out of sync by > 0.8 seconds AND tab is visible
      // Seeking while tab is hidden often causes YouTube to indefinitely pause until focused
      if (!document.hidden && Math.abs((player.getCurrentTime() || 0) - targetTime) > 0.8) {
        player.seekTo(targetTime, true);
      }
      
      // We MUST force playVideo even if hidden, otherwise the browser will permanently pause it
      if (player.getPlayerState() !== YT.PlayerState.PLAYING && player.getPlayerState() !== YT.PlayerState.BUFFERING) {
        player.playVideo();
      }
    } else {
      if (player.getPlayerState() === YT.PlayerState.PLAYING) {
        player.pauseVideo();
      }
    }
  }
  
  renderQueue();
}

function setupFirebaseListeners() {
  // Time Sync
  const offsetRef = ref(database, ".info/serverTimeOffset");
  onValue(offsetRef, (snapshot) => {
    serverTimeOffset = snapshot.val() || 0;
  });

  // State Sync (RADIO SYNC)
  const stateRef = ref(database, `rooms/${currentRoom}/state`);
  onValue(stateRef, (snapshot) => {
    const data = snapshot.val();
    if (data) {
      roomState = data;
      nowPlayingIndex = roomState.nowPlayingIndex;
      syncPlayerState();
    }
  });

  // Queue Sync
  const queueRef = ref(database, `rooms/${currentRoom}/queue`);
  onValue(queueRef, (snapshot) => {
    const data = snapshot.val();
    queue = [];
    if (data) {
      Object.keys(data).forEach(key => {
        queue.push({ id: key, ...data[key] });
      });
    }
    syncPlayerState();
    renderQueue();
  }, (error) => {
    console.error("Firebase Queue Error:", error);
  });

  // Chat Sync — single listener, updates both room chat and fullscreen chat overlay
  const chatRef = ref(database, `rooms/${currentRoom}/chat`);
  let lastProcessedChatKeys = new Set();
  let isInitialChatLoad = true;
  
  onValue(chatRef, (snapshot) => {
    const data = snapshot.val();
    renderChatMessages(data);
    
    // Render inline chat in fullscreen player
    if (data) {
      const fsInlineChat = document.getElementById('fsInlineChat');
      Object.entries(data).forEach(([key, msg]) => {
        if (!lastProcessedChatKeys.has(key)) {
          lastProcessedChatKeys.add(key);
          if (!isInitialChatLoad && fsInlineChat) {
            const el = document.createElement('div');
            el.className = 'fs-inline-msg';
            
            const senderSpan = document.createElement('span');
            senderSpan.className = 'sender';
            senderSpan.textContent = msg.user;
            
            const textSpan = document.createElement('span');
            textSpan.className = 'text';
            textSpan.textContent = msg.text;
            
            el.appendChild(senderSpan);
            el.appendChild(textSpan);
            fsInlineChat.appendChild(el);
            
            while (fsInlineChat.children.length > 6) {
              fsInlineChat.removeChild(fsInlineChat.firstChild);
            }
            
            setTimeout(() => {
              el.classList.add('fade-out');
              setTimeout(() => { if (el.parentNode) el.remove(); }, 600);
            }, 3500);
          }
        }
      });
    }
    isInitialChatLoad = false;
  });

  // Reactions Sync — receive emoji reactions from all users
  const reactionsRef = ref(database, `rooms/${currentRoom}/reactions`);
  onValue(reactionsRef, (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    // Find the latest reaction (highest timestamp we haven't seen)
    const entries = Object.values(data);
    entries.sort((a, b) => b.timestamp - a.timestamp);
    const latest = entries[0];
    // Only spawn if it was sent in the last 4 seconds (avoid replaying old ones on join)
    if (latest && Date.now() - latest.timestamp < 4000) {
      spawnEmoji(latest.emoji);
    }
  });


  // Participants Sync
  const participantsRef = ref(database, `rooms/${currentRoom}/participants`);
  onValue(participantsRef, (snapshot) => {
    activeParticipants = snapshot.val() || {};
    renderPeopleList();
  });

  // Invites Sync (Push Notifications + UI Toast)
  const myInvitesRef = ref(database, `users/${currentUser.uid}/invites`);
  onValue(myInvitesRef, (snapshot) => {
    const data = snapshot.val();
    if (data) {
      Object.entries(data).forEach(([key, invite]) => {
        // Only trigger if recent (e.g. last 60 seconds)
        if (Date.now() - invite.timestamp < 60000) {
          // Native Push Notification
          if (window.Notification && Notification.permission === 'granted') {
            const notif = new Notification(`VIBE Invite`, {
              body: `${invite.fromName} invited you to join room ${invite.room}`,
              icon: invite.fromPhoto || 'https://via.placeholder.com/40'
            });
            notif.onclick = () => {
              window.open(`/src/room.html?room=${invite.room}`, '_blank');
              notif.close();
            };
          }
          // UI Toast Popup
          showInviteToast(invite);
        }
        // Remove the invite so it doesn't re-trigger later
        remove(ref(database, `users/${currentUser.uid}/invites/${key}`));
      });
    }
  });
}

function showInviteToast(invite) {
  const toastContainer = document.getElementById('toastContainer');
  if (!toastContainer) return;

  const toast = document.createElement('div');
  toast.style.cssText = `
    background: rgba(17, 17, 26, 0.95);
    backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 16px;
    padding: 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    pointer-events: auto;
    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
    transform: translateX(120%);
    transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s;
  `;

  toast.innerHTML = `
    <img src="${invite.fromPhoto || 'https://via.placeholder.com/40'}" style="width: 44px; height: 44px; border-radius: 50%; object-fit: cover;">
    <div style="flex-grow: 1;">
      <div style="font-size: 0.9rem; font-weight: 700; margin-bottom: 2px;">Room Invite</div>
      <div style="font-size: 0.8rem; color: rgba(255,255,255,0.7);">${invite.fromName} invited you</div>
    </div>
    <button class="btn btn-primary" style="padding: 8px 16px; font-size: 0.8rem;">Join</button>
    <button class="close-toast" style="background: none; border: none; color: rgba(255,255,255,0.5); font-size: 1.2rem; cursor: pointer; padding: 0 4px;">×</button>
  `;

  toast.querySelector('.btn-primary').addEventListener('click', () => {
    window.location.href = `/src/room.html?room=${invite.room}`;
  });

  toast.querySelector('.close-toast').addEventListener('click', () => {
    toast.style.transform = 'translateX(120%)';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 400);
  });

  toastContainer.appendChild(toast);
  
  // Trigger animation reliably
  setTimeout(() => {
    toast.style.transform = 'translateX(0)';
  }, 10);

  // Auto dismiss after 15 seconds
  setTimeout(() => {
    if (toast.parentElement) {
      toast.style.transform = 'translateX(120%)';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 400);
    }
  }, 15000);
}

// Renders chat into BOTH the room chat panel AND the fullscreen chat overlay in real time
function renderChatMessages(data) {
  const panels = [
    document.getElementById('chatMessages'),
    document.getElementById('fsChatMessages')
  ];
  panels.forEach(panel => {
    if (!panel) return;
    panel.innerHTML = '';
    if (!data) return;
    Object.values(data).forEach(msg => {
      const el = document.createElement('div');
      el.style.cssText = 'background:rgba(255,255,255,0.05);padding:10px 14px;border-radius:12px;margin-bottom:8px;font-size:0.88rem;line-height:1.4;border:1px solid rgba(255,255,255,0.06);';
      el.innerHTML = `<strong style="color:rgba(255,255,255,0.9);">${msg.user}</strong> <span style="color:rgba(255,255,255,0.55);">${msg.text}</span>`;
      panel.appendChild(el);
    });
    panel.scrollTop = panel.scrollHeight;
  });
}

function renderPeopleList() {
  const peopleList = document.getElementById('peopleList');
  peopleList.innerHTML = '';
  let count = 0;
  
  Object.entries(activeParticipants).forEach(([uid, person]) => {
    count++;
    const card = document.createElement('div');
    card.className = `song-card`;
    card.style.padding = '16px';
    
    // Check if we should show the ADD FRIEND button
    const isMe = uid === currentUser.uid;
    const isFriend = myFriends.find(f => f.uid === uid);
    
    let btnHtml = '';
    if (!isMe && !isFriend) {
      btnHtml = `<button class="btn btn-primary add-friend-btn" style="padding: 6px 12px; font-size: 0.7rem;">ADD FRIEND</button>`;
    }
    
    // Check if in voice chat
    let voiceIcon = '';
    if (voiceParticipants[uid]) {
      const p = voiceParticipants[uid];
      if (p.isMuted) {
        voiceIcon = `<span style="color:#ff2d55; font-size: 1rem; margin-left: 8px;">🔇</span>`;
      } else {
        voiceIcon = `<span style="color:#34d399; font-size: 1.1rem; margin-left: 8px; filter: drop-shadow(0 0 8px rgba(52,211,153,0.6));">🔊</span>`;
      }
    }

    card.innerHTML = `
      <img src="${person.photoURL || 'https://via.placeholder.com/50'}" class="song-thumb" alt="User">
      <div class="song-details">
        <div class="song-title">${person.name} ${isMe ? '(You)' : ''}${voiceIcon}</div>
        <div class="song-artist">${person.status || 'Active'}</div>
      </div>
      ${btnHtml}
    `;
    
    if (!isMe && !isFriend) {
      card.querySelector('.add-friend-btn').addEventListener('click', () => {
        const newFriendRef = ref(database, `users/${currentUser.uid}/friends/${uid}`);
        set(newFriendRef, {
          name: person.name,
          photoURL: person.photoURL
        });
      });
    }
    
    peopleList.appendChild(card);
  });
  
  document.getElementById('peopleCount').innerText = count;
}

function loadCloudPlaylist() {
  const playlistRef = ref(database, `users/${currentUser.uid}/playlist`);
  onValue(playlistRef, (snapshot) => {
    const data = snapshot.val();
    myPlaylist = [];
    if (data) {
      Object.keys(data).forEach(key => {
        myPlaylist.push({ dbKey: key, ...data[key] });
      });
    }
    renderPlaylist();
  }, (error) => {
    console.error("Firebase Playlist Error:", error);
  });
}

function loadFriends() {
  const friendsRef = ref(database, `users/${currentUser.uid}/friends`);
  onValue(friendsRef, (snapshot) => {
    const data = snapshot.val();
    const friendsList = document.getElementById('friendsList');
    friendsList.innerHTML = '';
    myFriends = [];
    
    if (data) {
      Object.entries(data).forEach(([uid, friend]) => {
        myFriends.push({ uid, ...friend });
        
        const card = document.createElement('div');
        card.className = `song-card`;
        card.style.padding = '16px';
        
        card.innerHTML = `
          <img src="${friend.photoURL || 'https://via.placeholder.com/40'}" style="width: 40px; height: 40px; border-radius: 50%; margin-right: 10px;">
          <div class="song-details" style="flex-grow: 1;">
            <div class="song-title">${friend.name}</div>
          </div>
          <button class="btn btn-secondary invite-btn" style="padding: 6px 12px; font-size: 0.7rem;">INVITE</button>
        `;
        
        const inviteBtn = card.querySelector('.invite-btn');
        inviteBtn.addEventListener('click', () => {
          const friendInvitesRef = ref(database, `users/${uid}/invites`);
          push(friendInvitesRef, {
            room: currentRoom,
            fromName: currentUser.displayName || 'A friend',
            fromPhoto: currentUser.photoURL,
            timestamp: Date.now()
          }).then(() => {
            inviteBtn.innerText = 'SENT';
            inviteBtn.style.background = 'rgba(132, 204, 22, 0.2)';
            inviteBtn.style.color = '#84cc16';
            inviteBtn.style.borderColor = 'rgba(132, 204, 22, 0.4)';
          }).catch(err => console.error("Invite error:", err));
        });
        
        friendsList.appendChild(card);
      });
    } else {
       friendsList.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--text-secondary);">No friends yet.<br><br>When you add friends, you can invite them to rooms!</div>';
    }
    
    // Re-render people list to hide ADD FRIEND buttons if applicable
    renderPeopleList();
  });
}

// --- YouTube IFrame API Setup ---
let player;
let isPlayerReady = false;

// --- Silent Audio Hack ---
// Keeps the audio context alive in the background on mobile browsers
let isSilentAudioInitialized = false;
function initSilentAudio() {
  if (isSilentAudioInitialized) return;
  
  try {
    // 1. HTML5 Audio tag hack
    const silentAudio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA');
    silentAudio.loop = true;
    silentAudio.play().then(() => {
      isSilentAudioInitialized = true;
      document.removeEventListener('click', initSilentAudio);
      document.removeEventListener('touchstart', initSilentAudio);
    }).catch(e => console.log('Silent audio blocked', e));

    // 2. Web Audio API hack - use an inaudible high-frequency tone
    // Chrome sometimes suspends AudioContexts that are completely silent (gain = 0)
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      osc.frequency.value = 20000; // 20kHz (inaudible to most humans)
      const gain = ctx.createGain();
      gain.gain.value = 0.01; // Not fully 0, just very quiet
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(0);
    }
  } catch(err) {
    console.error(err);
  }
}

// Bind to first user interaction so mobile Safari accepts it
document.addEventListener('click', initSilentAudio);
document.addEventListener('touchstart', initSilentAudio);

function initYouTubePlayer() {
  player = new YT.Player('youtube-player', {
    height: '300',
    width: '300',
    videoId: 'dQw4w9WgXcQ', // Dummy fallback
    playerVars: {
      'playsinline': 1,
      'controls': 0,
      'fs': 0,
      'autoplay': 1,
      'rel': 0,
      'modestbranding': 1,
      'disablekb': 1,
      'iv_load_policy': 3,
      'origin': window.location.origin
    },
    events: {
      'onReady': onPlayerReady,
      'onStateChange': onPlayerStateChange
    }
  });
}

if (window.YT && window.YT.Player) {
  initYouTubePlayer();
} else {
  const oldReady = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = function() {
    if (oldReady) oldReady();
    initYouTubePlayer();
  };
}

function onPlayerReady(event) {
  isPlayerReady = true;
  syncPlayerState();
}

function onPlayerStateChange(event) {
  const playPauseBtn = document.getElementById('playPauseBtn');
  const thumb = document.getElementById('playerThumb');

  if (event.data == YT.PlayerState.PLAYING) {
    document.body.classList.remove('youtube-paused');
    initSilentAudio();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
      // Registering metadata is often required by Chrome/iOS to respect background playback
      if (queue[nowPlayingIndex]) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: queue[nowPlayingIndex].title,
          artist: queue[nowPlayingIndex].artist || 'Vibe Room',
          artwork: [{ src: queue[nowPlayingIndex].thumbnail || `https://i.ytimg.com/vi/${queue[nowPlayingIndex].videoId}/default.jpg`, sizes: '512x512', type: 'image/jpeg' }]
        });
      }
    }
    
    if (playPauseBtn) playPauseBtn.innerHTML = UI_ICONS.pause;
    if (thumb) thumb.classList.remove('paused');
    // Sync fullscreen UI if open
    if (typeof fsPlayPauseBtn !== 'undefined' && fsPlayPauseBtn) fsPlayPauseBtn.innerHTML = `<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
    if (typeof fsArtwork !== 'undefined' && fsArtwork) fsArtwork.classList.add('playing');
    startProgressBar();
  } else if (event.data == YT.PlayerState.PAUSED || event.data == YT.PlayerState.UNSTARTED) {
    document.body.classList.add('youtube-paused');
    // Hack: If browser auto-paused the video because the tab went to background or any other reason, force it back!
    if (roomState && roomState.isPlaying) {
      setTimeout(() => {
        if (player.getPlayerState() !== YT.PlayerState.PLAYING) player.playVideo();
      }, 50);
      return;
    }

    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    
    if (playPauseBtn) playPauseBtn.innerHTML = UI_ICONS.play;
    if (thumb) thumb.classList.add('paused');
    if (typeof fsPlayPauseBtn !== 'undefined' && fsPlayPauseBtn) fsPlayPauseBtn.innerHTML = `<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3v18l15-9z"/></svg>`;
    if (typeof fsArtwork !== 'undefined' && fsArtwork) fsArtwork.classList.remove('playing');
    stopProgressBar();
  }

  if (event.data == YT.PlayerState.ENDED) {
    playNext();
  }
}

// --- Player Controls ---
document.getElementById('playPauseBtn').addEventListener('click', () => {
  if (!isPlayerReady || queue.length === 0) return;
  
  // Browser Autoplay Block Bypass:
  // If the room says it's playing but the local browser blocked it from starting,
  // clicking Play locally should just force the browser to sync without pausing the room!
  if (roomState.isPlaying && player.getPlayerState() !== YT.PlayerState.PLAYING) {
    player.playVideo();
    return;
  }
  
  const stateRef = ref(database, `rooms/${currentRoom}/state`);
  set(stateRef, {
    nowPlayingIndex: nowPlayingIndex,
    isPlaying: !roomState.isPlaying,
    seekPosition: player.getCurrentTime() || 0,
    lastUpdatedAt: getServerTime()
  });
});

document.getElementById('nextBtn').addEventListener('click', playNext);

// Aggressively prevent browser from pausing YouTube iframe when switching tabs
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Tab went to background. If we should be playing, force the YouTube API to stay playing
    if (isPlayerReady && roomState && roomState.isPlaying && player.getPlayerState() !== YT.PlayerState.PLAYING) {
      setTimeout(() => player.playVideo(), 50);
    }
  } else {
    // Tab came back to foreground. Force sync if it got paused somehow
    if (isPlayerReady && roomState && roomState.isPlaying && player.getPlayerState() !== YT.PlayerState.PLAYING) {
      setTimeout(() => player.playVideo(), 50);
    }
  }
});

// prevBtn: go to beginning of current song or previous
document.getElementById('prevBtn')?.addEventListener('click', () => {
  if (!isPlayerReady) return;
  const cur = player.getCurrentTime() || 0;
  if (cur > 3 || nowPlayingIndex === 0) {
    // Restart current song
    const stateRef = ref(database, `rooms/${currentRoom}/state`);
    set(stateRef, { nowPlayingIndex, isPlaying: roomState.isPlaying, seekPosition: 0, lastUpdatedAt: getServerTime() });
    player.seekTo(0, true);
  } else {
    // Go to previous
    const stateRef = ref(database, `rooms/${currentRoom}/state`);
    set(stateRef, { nowPlayingIndex: nowPlayingIndex - 1, isPlaying: true, seekPosition: 0, lastUpdatedAt: getServerTime() });
  }
});

function playNext() {
  if (queue.length === 0) return;
  
  let nextIndex = nowPlayingIndex + 1;
  if (nextIndex >= queue.length) {
    nextIndex = 0; // Loop back for demo
  }
  
  const stateRef = ref(database, `rooms/${currentRoom}/state`);
  set(stateRef, {
    nowPlayingIndex: nextIndex,
    isPlaying: true,
    seekPosition: 0,
    lastUpdatedAt: getServerTime()
  });
}

// --- Mini Player UI ---
let progressInterval;

function updateMiniPlayerUI() {
  const currentSong = queue[nowPlayingIndex];
  if (!currentSong) return;
  
  document.getElementById('playerTitle').innerText = currentSong.title;
  document.getElementById('playerArtist').innerText = currentSong.artist;
  document.getElementById('playerThumb').src = `https://i.ytimg.com/vi/${currentSong.videoId}/default.jpg`;
  
  // Keep fullscreen in sync if open
  if (typeof isFullscreen !== 'undefined' && isFullscreen) {
    // updateFullscreenUI will be called after it's defined
    setTimeout(() => { if (typeof updateFullscreenUI === 'function') updateFullscreenUI(); }, 0);
  }

  // Hook into OS Media Controls (Lock Screen / Control Center)
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentSong.title,
      artist: currentSong.artist || 'VIBE Room',
      artwork: [
        { src: `https://i.ytimg.com/vi/${currentSong.videoId}/default.jpg`, sizes: '120x90', type: 'image/jpeg' },
        { src: `https://i.ytimg.com/vi/${currentSong.videoId}/maxresdefault.jpg`, sizes: '1280x720', type: 'image/jpeg' }
      ]
    });
    
    // Bind OS media buttons to our player controls
    navigator.mediaSession.setActionHandler('play', () => document.getElementById('playPauseBtn').click());
    navigator.mediaSession.setActionHandler('pause', () => document.getElementById('playPauseBtn').click());
    navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
    navigator.mediaSession.setActionHandler('previoustrack', () => document.getElementById('prevBtn')?.click());
  }
}

function startProgressBar() {
  const progressBar = document.getElementById('progressBar');
  clearInterval(progressInterval);
  progressInterval = setInterval(() => {
    if (isPlayerReady && player.getDuration) {
      const duration = player.getDuration();
      const current = player.getCurrentTime();
      if (duration > 0) {
        const percent = (current / duration) * 100;
        progressBar.style.width = `${percent}%`;
      }
    }
  }, 1000);
}

function stopProgressBar() {
  clearInterval(progressInterval);
}

// --- Queue Rendering ---
function renderQueue() {
  const queueList = document.getElementById('queueList');
  queueList.innerHTML = '';
  
  queue.forEach((song) => {
    const isPlaying = queue[nowPlayingIndex]?.id === song.id;
    
    const card = document.createElement('div');
    card.className = `song-card ${isPlaying ? 'now-playing' : ''}`;
    
    card.innerHTML = `
      <img src="https://i.ytimg.com/vi/${song.videoId}/default.jpg" class="song-thumb">
      <div class="song-details" style="flex-grow: 1;">
        <div class="song-title">${song.title}</div>
        <div class="song-artist">${song.artist}</div>
        <div class="added-by">Added by ${song.addedBy}</div>
      </div>
    `;
    
    queueList.appendChild(card);
  });
}

// --- Add Song / Search Modal & Playlist ---
const addSongBtn = document.getElementById('addSongBtn');
const searchModal = document.getElementById('searchModal');
const closeSearchModal = document.getElementById('closeSearchModal');
const searchInput = document.getElementById('searchInput');
const doSearchBtn = document.getElementById('doSearchBtn');
const searchResults = document.getElementById('searchResults');
const playlistResults = document.getElementById('playlistResults');

const joinVoiceBtn = document.getElementById('joinVoiceBtn');
const leaveVoiceBtn = document.getElementById('leaveVoiceBtn');
const voiceMuteBtn = document.getElementById('voiceMuteBtn');

joinVoiceBtn?.addEventListener('click', async () => {
  if (!currentUser) return;
  joinVoiceBtn.disabled = true;
  joinVoiceBtn.innerHTML = 'Connecting...';
  
  const success = await joinVoice(currentRoom, currentUser.uid, (uid, data) => {
    if (!data) delete voiceParticipants[uid];
    else voiceParticipants[uid] = data;
    renderPeopleList();
  });
  
  if (success) {
    inVoiceChat = true;
    joinVoiceBtn.classList.add('hidden');
    leaveVoiceBtn.classList.remove('hidden');
    voiceMuteBtn.classList.remove('hidden');
    // Duck audio to 50%
    if (player && player.setVolume) player.setVolume(50);
  } else {
    joinVoiceBtn.disabled = false;
    joinVoiceBtn.innerHTML = 'Join Voice';
  }
});

leaveVoiceBtn?.addEventListener('click', () => {
  leaveVoice();
  inVoiceChat = false;
  joinVoiceBtn.classList.remove('hidden');
  joinVoiceBtn.disabled = false;
  joinVoiceBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
    Join Voice
  `;
  leaveVoiceBtn.classList.add('hidden');
  voiceMuteBtn.classList.add('hidden');
  
  // Restore volume
  if (player && player.setVolume) player.setVolume(100);
  
  voiceParticipants = {};
  renderPeopleList();
});

voiceMuteBtn?.addEventListener('click', () => {
  const isMuted = toggleMute();
  const micIcon = document.getElementById('micIcon');
  if (isMuted) {
    voiceMuteBtn.style.background = 'rgba(255,45,85,0.2)';
    voiceMuteBtn.style.color = '#ff2d55';
    micIcon.innerHTML = `<line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="22"></line>`;
  } else {
    voiceMuteBtn.style.background = 'rgba(255,255,255,0.15)';
    voiceMuteBtn.style.color = 'inherit';
    micIcon.innerHTML = `<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>`;
  }
});

const YOUTUBE_API_KEY = 'AIzaSyDuz95QvhC2iLVXanoH1abBY7hbXyyYol8'; 

addSongBtn.addEventListener('click', () => {
  searchModal.classList.remove('hidden');
  setTimeout(() => searchInput.focus(), 100);
});

const overlaySearchInput = document.getElementById('overlaySearchInput');
if (overlaySearchInput) {
  overlaySearchInput.addEventListener('click', () => {
    // Open the same search modal that's used for adding songs
    searchModal.classList.remove('hidden');
    setTimeout(() => searchInput.focus(), 100);
  });
}

closeSearchModal.addEventListener('click', () => {
  searchModal.classList.add('hidden');
});

function addToQueueAndPlay(song) {
  const queueRef = ref(database, `rooms/${currentRoom}/queue`);
  const isFirst = queue.length === 0;
  
  push(queueRef, {
    videoId: song.videoId,
    title: song.title,
    artist: song.artist,
    addedBy: currentUser.displayName || 'Anonymous',
    timestamp: Date.now()
  });
  
  // If first song, auto-initialize the radio state!
  if (isFirst) {
    const stateRef = ref(database, `rooms/${currentRoom}/state`);
    set(stateRef, {
      nowPlayingIndex: 0,
      isPlaying: true,
      seekPosition: 0,
      lastUpdatedAt: getServerTime()
    });
  }
  
  searchModal.classList.add('hidden');
  searchInput.value = '';
  searchResults.innerHTML = '';
}

doSearchBtn.addEventListener('click', async () => {
  const query = searchInput.value.trim();
  if (!query) return;

  searchResults.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--text-secondary);">Searching...</div>';

  let results = [];

  if (YOUTUBE_API_KEY) {
    try {
      const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=5&q=${encodeURIComponent(query)}&type=video&key=${YOUTUBE_API_KEY}`);
      const data = await res.json();
      
      if (data.items) {
        results = data.items.map(item => ({
          videoId: item.id.videoId,
          title: item.snippet.title,
          artist: item.snippet.channelTitle,
          thumbnail: item.snippet.thumbnails.default.url
        }));
      }
    } catch (err) {
      console.error('YouTube API Error', err);
      searchResults.innerHTML = '<div style="text-align:center; color: var(--accent-pink);">Error fetching results. Check console.</div>';
      return;
    }
  }

  searchResults.innerHTML = '';
  
  if (results.length === 0) {
    searchResults.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--text-secondary);">No results found.</div>';
    return;
  }

  results.forEach(res => {
    const card = document.createElement('div');
    card.className = 'song-card';
    card.style.cursor = 'default';

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = res.title;
    const cleanTitle = tempDiv.textContent || tempDiv.innerText || '';

    // Build elements manually so event listeners attach correctly
    const thumb = document.createElement('img');
    thumb.src = res.thumbnail;
    thumb.className = 'song-thumb';

    const details = document.createElement('div');
    details.className = 'song-details';
    details.style.flexGrow = '1';
    details.innerHTML = `
      <div class="song-title">${cleanTitle}</div>
      <div class="song-artist">${res.artist}</div>
    `;

    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex; gap:8px; flex-shrink:0; align-items:center;';

    // Save to playlist button
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.innerHTML = UI_ICONS.heartEmpty;
    saveBtn.title = 'Save to Playlist';
    saveBtn.style.cssText = 'width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.7);border:1px solid rgba(255,255,255,0.15);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background 0.2s,transform 0.15s;';
    
    // Check if already saved
    if (myPlaylist.find(s => s.videoId === res.videoId)) {
      saveBtn.innerHTML = UI_ICONS.check;
      saveBtn.style.color = '#84cc16';
    }

    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!myPlaylist.find(s => s.videoId === res.videoId)) {
        const playlistRef = ref(database, `users/${currentUser.uid}/playlist`);
        push(playlistRef, { videoId: res.videoId, title: cleanTitle, artist: res.artist, thumbnail: res.thumbnail })
          .then(() => {
            saveBtn.innerHTML = UI_ICONS.check;
            saveBtn.style.color = '#84cc16';
            saveBtn.style.background = 'rgba(132,204,22,0.2)';
          })
          .catch(err => {
            console.error('Error saving to playlist:', err);
            alert('Failed to save. Check Firebase rules.');
          });
      }
    });

    // Add to queue button
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.innerHTML = `<span style="display:flex;align-items:center;gap:4px;">${UI_ICONS.plus} Queue</span>`;
    addBtn.style.cssText = 'padding:8px 14px;border-radius:999px;background:white;color:#000;border:none;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;transition:background 0.15s,transform 0.15s;display:flex;align-items:center;';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      addToQueueAndPlay({ videoId: res.videoId, title: cleanTitle, artist: res.artist });
      addBtn.innerHTML = `<span style="display:flex;align-items:center;gap:4px;">${UI_ICONS.check} Added</span>`;
      addBtn.style.background = 'rgba(132,204,22,0.85)';
    });

    btnGroup.appendChild(saveBtn);
    btnGroup.appendChild(addBtn);

    card.appendChild(thumb);
    card.appendChild(details);
    card.appendChild(btnGroup);

    searchResults.appendChild(card);
  });
});

searchInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') doSearchBtn.click();
});

// Render Personal Playlist
function renderPlaylist() {
  playlistResults.innerHTML = '';
  
  if (myPlaylist.length === 0) {
    playlistResults.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--text-secondary);">Your cloud playlist is empty.<br><br>Search for songs and click ❤️ to save them.</div>';
    return;
  }
  
  myPlaylist.forEach((song) => {
    const card = document.createElement('div');
    card.className = 'song-card';
    
    card.innerHTML = `
      <img src="${song.thumbnail}" class="song-thumb">
      <div class="song-details" style="display: flex; flex-direction: column; justify-content: center; flex-grow: 1;">
        <div class="song-title" style="font-size: 0.9rem; line-height: 1.2; margin-bottom: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${song.title}</div>
        <div class="song-artist">${song.artist}</div>
      </div>
      <div style="display: flex; gap: 5px; flex-shrink: 0;">
        <button class="btn btn-secondary remove-btn" style="padding: 6px 10px; font-size: 0.8rem; border-color: rgba(255,0,0,0.4);" title="Remove">🗑️</button>
        <button class="btn btn-primary queue-btn" style="padding: 6px 12px; font-size: 0.7rem;">ADD</button>
      </div>
    `;
    
    card.querySelector('.queue-btn').addEventListener('click', () => {
      addToQueueAndPlay(song);
    });
    
    card.querySelector('.remove-btn').addEventListener('click', () => {
      const songRef = ref(database, `users/${currentUser.uid}/playlist/${song.dbKey}`);
      remove(songRef);
    });
    
    playlistResults.appendChild(card);
  });
}

// --- Floating Emoji Reactions (main view fab) ---
const reactionBtn = document.getElementById('reactionBtn');
reactionBtn.addEventListener('click', () => broadcastEmoji('🔥'));

// --- View Navigation (defined at bottom with animations) ---
const views = {
  queue: document.getElementById('queueView'),
  room: document.getElementById('peopleView'),
  chat: document.getElementById('chatView'),
  playlist: document.getElementById('playlistView')
};

const navItems = {
  queue: document.getElementById('nav-queue'),
  room: document.getElementById('nav-room'),
  chat: document.getElementById('nav-chat'),
  playlist: document.getElementById('nav-playlist'),
  home: document.getElementById('nav-home'),
  search: document.getElementById('nav-search')
};

// --- Chat Send (room view) ---
const sendChatBtn = document.getElementById('sendChatBtn');
const chatInput = document.getElementById('chatInput');

function sendChat(text) {
  if (!text || !currentUser) return;
  const chatRef = ref(database, `rooms/${currentRoom}/chat`);
  push(chatRef, {
    user: currentUser.displayName || 'Anonymous',
    text: text,
    timestamp: Date.now()
  });
}

sendChatBtn.addEventListener('click', () => {
  const text = chatInput.value.trim();
  if (text) { sendChat(text); chatInput.value = ''; }
});
chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChatBtn.click(); });

// --- Full-Screen Player ---
const fullscreenPlayer = document.getElementById('fullscreenPlayer');
const fsCloseBtn       = document.getElementById('fsCloseBtn');
const fsArtwork        = document.getElementById('fsArtwork');
const fsBgArt          = document.getElementById('fsBgArt');
const fsSongTitle      = document.getElementById('fsSongTitle');
const fsSongArtist     = document.getElementById('fsSongArtist');
const fsPlayPauseBtn   = document.getElementById('fsPlayPauseBtn');
const fsPrevBtn        = document.getElementById('fsPrevBtn');
const fsNextBtn        = document.getElementById('fsNextBtn');
const fsProgressFill   = document.getElementById('fsProgressFill');
const fsCurrentTime    = document.getElementById('fsCurrentTime');
const fsDuration       = document.getElementById('fsDuration');
const fsLikeBtn        = document.getElementById('fsLikeBtn');

// Chat overlay in fullscreen
const fsChatOverlay    = document.getElementById('fsChatOverlay');
const fsChatToggle     = document.getElementById('fsChatToggle');
const fsChatCloseBtn   = document.getElementById('fsChatCloseBtn');
const fsToggleSong     = document.getElementById('fsToggleSong');
const fsToggleVideo    = document.getElementById('fsToggleVideo');
const fsChatMessages   = document.getElementById('fsChatMessages');
const fsChatInput      = document.getElementById('fsChatInput');
const fsSendChatBtn    = document.getElementById('fsSendChatBtn');

let isFullscreen = false;

// Open fullscreen player when tapping the mini player
document.getElementById('miniPlayer').addEventListener('click', (e) => {
  // Don't open if clicking control buttons
  if (e.target.closest('.player-controls button')) return;
  openFullscreen();
});

function openFullscreen() {
  isFullscreen = true;
  document.body.classList.add('fullscreen-open');
  fullscreenPlayer.classList.add('open');
  updateFullscreenUI();
  updateVideoPosition();
  startFsProgressUpdater();
}

function closeFullscreen() {
  isFullscreen = false;
  document.body.classList.remove('fullscreen-open');
  fullscreenPlayer.classList.remove('open');
  fsChatOverlay.classList.remove('open');
  document.body.classList.remove('chat-overlay-open');
  if (fsToggleSong) fsToggleSong.click();
  stopFsProgressUpdater();
}

fsCloseBtn.addEventListener('click', closeFullscreen);

// Full-screen play/pause
fsPlayPauseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('playPauseBtn').click();
});

fsPrevBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('prevBtn').click();
});

fsNextBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('nextBtn').click();
});

// Like button — broadcast a heart reaction to all users
fsLikeBtn.addEventListener('click', () => {
  fsLikeBtn.classList.toggle('liked');
  fsLikeBtn.innerHTML = fsLikeBtn.classList.contains('liked') ? UI_ICONS.heartFilled : UI_ICONS.heartEmpty;
  broadcastEmoji('❤️');
});

function updateFullscreenUI() {
  const song = queue[nowPlayingIndex];
  if (!song) return;

  const artUrl = `https://i.ytimg.com/vi/${song.videoId}/maxresdefault.jpg`;
  fsArtwork.src = artUrl;
  fsBgArt.style.backgroundImage = `url(${artUrl})`;
  fsSongTitle.textContent = song.title;
  fsSongArtist.textContent = song.artist;

  const fsRoomLabel = document.getElementById('fsRoomLabel');
  if (fsRoomLabel) fsRoomLabel.textContent = `ROOM ${currentRoom}`;

  // Sync play state
  if (roomState.isPlaying) {
    fsPlayPauseBtn.textContent = '⏸';
    fsArtwork.classList.add('playing');
  } else {
    fsPlayPauseBtn.textContent = '▶';
    fsArtwork.classList.remove('playing');
  }
}

// Fullscreen progress updater
let fsProgressInterval;

function startFsProgressUpdater() {
  clearInterval(fsProgressInterval);
  fsProgressInterval = setInterval(() => {
    if (!isPlayerReady || !player.getDuration) return;
    const duration = player.getDuration();
    const current  = player.getCurrentTime();
    if (!duration) return;

    fsProgressFill.style.width = `${(current / duration) * 100}%`;
    fsCurrentTime.textContent = formatTime(current);
    fsDuration.textContent    = formatTime(duration);
  }, 500);
}

function stopFsProgressUpdater() {
  clearInterval(fsProgressInterval);
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// Keep fullscreen UI in sync — called when state or queue changes
function syncAndUpdateFS() {
  if (isFullscreen) updateFullscreenUI();
}

// Hook into state listener — detect play/pause changes
// (onPlayerStateChange is already defined above near YouTube setup)

// FS Chat overlay toggle
fsChatToggle.addEventListener('click', () => {
  fsChatOverlay.classList.toggle('open');
  document.body.classList.toggle('chat-overlay-open', fsChatOverlay.classList.contains('open'));
  
  if (fsChatOverlay.classList.contains('open')) {
    // Chat is auto-synced by the central Firebase listener — just focus input
    setTimeout(() => fsChatInput.focus(), 400);
  }
});

// Audio / Video Toggle
const ytViewportWrapper = document.getElementById('yt-viewport-wrapper');

function updateVideoPosition() {
  if (document.body.classList.contains('video-mode-active') && isFullscreen) {
    const artRect = fsArtwork.getBoundingClientRect();
    if (artRect.height > 0 && ytViewportWrapper) {
      ytViewportWrapper.style.top = (artRect.top + artRect.height / 2) + 'px';
    }
  } else if (ytViewportWrapper) {
    ytViewportWrapper.style.top = '50%';
  }
}
window.addEventListener('resize', updateVideoPosition);

if (fsToggleSong && fsToggleVideo) {
  fsToggleSong.addEventListener('click', () => {
    fsToggleSong.classList.add('active');
    fsToggleVideo.classList.remove('active');
    fullscreenPlayer.classList.remove('video-mode-active');
    document.body.classList.remove('video-mode-active');
    updateVideoPosition();
  });

  fsToggleVideo.addEventListener('click', () => {
    fsToggleVideo.classList.add('active');
    fsToggleSong.classList.remove('active');
    fullscreenPlayer.classList.add('video-mode-active');
    document.body.classList.add('video-mode-active');
    updateVideoPosition();
  });
}

fsChatCloseBtn.addEventListener('click', () => {
  fsChatOverlay.classList.remove('open');
  document.body.classList.remove('chat-overlay-open');
});

fsSendChatBtn.addEventListener('click', () => {
  const text = fsChatInput.value.trim();
  if (text) { sendChat(text); fsChatInput.value = ''; }
});
fsChatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') fsSendChatBtn.click(); });

// syncFsChatMessages removed — chat is now handled by the central renderChatMessages
// listener in setupFirebaseListeners which updates both panels simultaneously


// spawnEmoji — purely local animation, called by Firebase reaction listener
function spawnEmoji(emoji) {
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = emoji;

  const tilts = ['-10deg', '12deg', '-6deg', '8deg', '-14deg'];
  el.style.setProperty('--tilt-1', tilts[Math.floor(Math.random() * tilts.length)]);
  el.style.setProperty('--tilt-2', tilts[Math.floor(Math.random() * tilts.length)]);
  el.style.setProperty('--tilt-3', tilts[Math.floor(Math.random() * tilts.length)]);
  el.style.setProperty('--duration', `${2.4 + Math.random() * 1.2}s`);
  el.style.left   = `${15 + Math.random() * 70}%`;
  el.style.bottom = `${isFullscreen ? 30 : 22}%`;
  el.style.fontSize = `${2 + Math.random() * 1.2}rem`;
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// broadcastEmoji — push to Firebase so ALL users in the room see it
function broadcastEmoji(emoji) {
  if (!currentUser || !currentRoom) return;
  const reactionsRef = ref(database, `rooms/${currentRoom}/reactions`);
  push(reactionsRef, {
    emoji,
    uid: currentUser.uid,
    timestamp: Date.now()
  });
  // Prune old reactions (keep last 20) to avoid Firebase bloat
  // (simple approach: just let them accumulate, Firebase is cheap for this)
}

// Wire up reaction buttons — broadcast to Firebase so all users see it
document.querySelectorAll('.reaction-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    broadcastEmoji(btn.dataset.emoji);
    // Burst animation on button
    btn.style.transform = 'scale(1.5)';
    btn.style.transition = 'transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)';
    setTimeout(() => { btn.style.transform = ''; }, 300);
  });
});

// View transition animation
function switchView(viewName) {
  if (viewName === 'home') { openHomeOverlay(); return; }
  if (viewName === 'search') {
    searchModal.classList.remove('hidden');
    setTimeout(() => document.getElementById('searchInput').focus(), 100);
    return;
  }

  Object.values(views).forEach(v => v?.classList.add('hidden'));
  Object.values(navItems).forEach(n => n?.classList.remove('active'));

  if (views[viewName]) {
    views[viewName].classList.remove('hidden');
    views[viewName].classList.remove('view-enter');
    void views[viewName].offsetWidth;
    views[viewName].classList.add('view-enter');
  }
  if (navItems[viewName]) navItems[viewName].classList.add('active');

  if (viewName === 'playlist') renderPlaylist();
}

navItems.queue?.addEventListener('click', () => switchView('queue'));
navItems.room?.addEventListener('click', () => switchView('room'));
navItems.chat?.addEventListener('click', () => switchView('chat'));
navItems.playlist?.addEventListener('click', () => switchView('playlist'));
navItems.home?.addEventListener('click', () => switchView('home'));
navItems.search?.addEventListener('click', () => switchView('search'));

// ================================================================
// HOME OVERLAY — keeps music alive, no page navigation
// ================================================================
const homeOverlay       = document.getElementById('homeOverlay');
const homeOverlayClose  = document.getElementById('homeOverlayCloseBtn');
const homeNpThumb       = document.getElementById('homeNpThumb');
const homeNpTitle       = document.getElementById('homeNpTitle');
const homeNpRoom        = document.getElementById('homeNpRoom');
const homeNpPlayPause   = document.getElementById('homeNpPlayPause');
const homeOverlayPlaylist = document.getElementById('homeOverlayPlaylist');

// back button in header
document.getElementById('goHomeBtn')?.addEventListener('click', openHomeOverlay);

function openHomeOverlay() {
  homeOverlay.style.transform = 'translateY(0)';
  homeOverlay.style.pointerEvents = 'all';
  homeOverlay.style.visibility = 'visible';
  document.body.classList.add('home-overlay-open');

  // Populate now-playing bar
  const song = queue[nowPlayingIndex];
  if (song) {
    homeNpThumb.src = `https://i.ytimg.com/vi/${song.videoId}/hqdefault.jpg`;
    homeNpTitle.textContent = song.title;
  }
  if (homeNpRoom) homeNpRoom.textContent = currentRoom;
  syncHomeNpPlayPause();

  // Populate playlist
  renderHomeOverlayPlaylist();
}

function closeHomeOverlay() {
  homeOverlay.style.transform = 'translateY(100%)';
  homeOverlay.style.pointerEvents = 'none';
  homeOverlay.style.visibility = 'hidden';
  document.body.classList.remove('home-overlay-open');
}

homeOverlayClose?.addEventListener('click', closeHomeOverlay);

// Play/pause from home overlay now-playing bar
homeNpPlayPause?.addEventListener('click', () => {
  document.getElementById('playPauseBtn').click();
  syncHomeNpPlayPause();
});

function syncHomeNpPlayPause() {
  if (!homeNpPlayPause) return;
  homeNpPlayPause.innerHTML = roomState.isPlaying ? UI_ICONS.pause : UI_ICONS.play;
}

// Render the user's playlist inside the home overlay
function renderHomeOverlayPlaylist() {
  if (!homeOverlayPlaylist) return;
  homeOverlayPlaylist.innerHTML = '';

  if (myPlaylist.length === 0) {
    homeOverlayPlaylist.innerHTML = `
      <div class="empty-playlist">
        <div class="empty-playlist-emoji">🎵</div>
        <p>Your cloud playlist is empty.<br>Use search to save songs!</p>
      </div>`;
    return;
  }

  myPlaylist.forEach(song => {
    const card = document.createElement('div');
    card.className = 'home-song-card';
    
    card.innerHTML = `
      <img src="${song.thumbnail || `https://i.ytimg.com/vi/${song.videoId}/default.jpg`}" class="home-song-thumb" alt="Thumbnail">
      <div class="home-song-info">
        <div class="home-song-title" style="color: #0F0F1A;">${song.title}</div>
        <div class="home-song-artist" style="color: #6B7280;">${song.artist || ''}</div>
      </div>
      <button class="btn btn-secondary btn-xs add-from-playlist-btn" style="border-radius:99px; background: rgba(108,99,255,0.1); color: #6C63FF; border: none;">＋ Queue</button>
    `;

    const addBtn = card.querySelector('.add-from-playlist-btn');
    addBtn.addEventListener('click', () => {
      addToQueueAndPlay(song);
      
      // visual feedback
      addBtn.textContent = 'Queued ✓';
      addBtn.style.background = '#10B981';
      addBtn.style.color = 'white';
      setTimeout(() => {
        addBtn.textContent = '＋ Queue';
        addBtn.style.background = 'rgba(108,99,255,0.1)';
        addBtn.style.color = '#6C63FF';
      }, 2000);
      
      closeHomeOverlay();
    });

    homeOverlayPlaylist.appendChild(card);
  });
}

// Home overlay — Create Room
document.getElementById('homeOverlayCreateBtn')?.addEventListener('click', () => {
  const code = generateRoomCode();
  window.location.href = `/src/room.html?room=${code}&host=true`;
});

// Home overlay — Join Different Room
const homeJoinModal      = document.getElementById('homeJoinModal');
const homeJoinCodeInput  = document.getElementById('homeJoinCodeInput');
const homeJoinSubmitBtn  = document.getElementById('homeJoinSubmitBtn');
const homeJoinCancelBtn  = document.getElementById('homeJoinCancelBtn');

document.getElementById('homeOverlayJoinBtn')?.addEventListener('click', () => {
  homeJoinModal.style.opacity = '1';
  homeJoinModal.style.pointerEvents = 'all';
  homeJoinModal.style.visibility = 'visible';
});

homeJoinCancelBtn?.addEventListener('click', () => {
  homeJoinModal.style.opacity = '0';
  homeJoinModal.style.pointerEvents = 'none';
  homeJoinModal.style.visibility = 'hidden';
});

homeJoinSubmitBtn?.addEventListener('click', () => {
  const code = homeJoinCodeInput.value.trim().toUpperCase();
  if (code) {
    window.location.href = `/src/room.html?room=${code}`;
  } else {
    homeJoinCodeInput?.focus();
  }
});

homeJoinCodeInput?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') homeJoinSubmitBtn?.click();
});

