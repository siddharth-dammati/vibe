import { auth, database, googleProvider, signInWithPopup, onAuthStateChanged, ref, onValue, remove, push, set } from './firebase.js';

document.addEventListener('DOMContentLoaded', () => {
  const createRoomBtn = document.getElementById('createRoomBtn');
  const joinRoomBtn = document.getElementById('joinRoomBtn');
  const joinModal = document.getElementById('joinModal');
  const closeModal = document.getElementById('closeModal');
  const submitJoinBtn = document.getElementById('submitJoinBtn');
  const roomCodeInput = document.getElementById('roomCodeInput');
  const landingView = document.getElementById('landingView');
  const dashboardView = document.getElementById('dashboardView');
  const welcomeText = document.getElementById('welcomeText');
  const homePlaylistContainer = document.getElementById('homePlaylistContainer');

  let playlistListener = null;

  // Auth State Listener
  onAuthStateChanged(auth, (user) => {
    if (user) {
      landingView.classList.add('hidden');
      dashboardView.classList.remove('hidden');
      
      const firstName = user.displayName ? user.displayName.split(' ')[0] : 'User';
      welcomeText.innerHTML = `Hey, <span class="accent-text">${firstName}</span> 👋`;
      
      // Fetch Playlist
      const playlistRef = ref(database, `users/${user.uid}/playlist`);
      playlistListener = onValue(playlistRef, (snapshot) => {
        const data = snapshot.val();
        homePlaylistContainer.innerHTML = '';
        
        if (data) {
          Object.values(data).forEach(song => {
            const card = document.createElement('div');
            card.className = 'song-card';
            card.innerHTML = `
              <img src="${song.thumbnail}" class="song-thumb">
              <div class="song-details" style="display: flex; flex-direction: column; justify-content: center; flex-grow: 1;">
                <div class="song-title" style="font-size: 0.9rem; line-height: 1.2; margin-bottom: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${song.title}</div>
                <div class="song-artist">${song.artist}</div>
              </div>
            `;
            homePlaylistContainer.appendChild(card);
          });
        } else {
          homePlaylistContainer.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--text-secondary); font-size: 0.9rem;">Your cloud playlist is empty.<br><br>Join a room to search and save songs!</div>';
        }
      });
      
      // Listen for incoming invites
      const invitesRef = ref(database, `users/${user.uid}/invites`);
      onValue(invitesRef, (snapshot) => {
        const data = snapshot.val();
        if (data) {
          Object.entries(data).forEach(([key, invite]) => {
            // Only show recent invites (last 60s)
            if (Date.now() - invite.timestamp < 60000) {
              showInviteToast(invite);
            }
            // Remove the invite so it doesn't trigger again
            remove(ref(database, `users/${user.uid}/invites/${key}`));
          });
        }
      });
      
    } else {
      landingView.classList.remove('hidden');
      dashboardView.classList.add('hidden');
      
      if (playlistListener) {
         // Firebase v9 modular onValue returns an unsubscribe function
         playlistListener();
         playlistListener = null;
      }
    }
  });

  const signInBtn = document.getElementById('signInBtn');
  signInBtn.addEventListener('click', () => {
    signInWithPopup(auth, googleProvider).catch(error => {
      console.error("Error signing in", error);
      alert("Sign in failed. Check console.");
    });
  });

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

  // Utility to generate random room code
  const generateRoomCode = () => {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
  };

  createRoomBtn.addEventListener('click', () => {
    const roomCode = generateRoomCode();
    window.location.href = `/src/room.html?room=${roomCode}&host=true`;
  });

  const createRoomBtn2 = document.getElementById('createRoomBtn2');
  if (createRoomBtn2) {
    createRoomBtn2.addEventListener('click', () => {
      const roomCode = generateRoomCode();
      window.location.href = `/src/room.html?room=${roomCode}&host=true`;
    });
  }

  joinRoomBtn.addEventListener('click', () => {
    joinModal.classList.remove('hidden');
  });

  const joinRoomBtn2 = document.getElementById('joinRoomBtn2');
  if (joinRoomBtn2) {
    joinRoomBtn2.addEventListener('click', () => {
      joinModal.classList.remove('hidden');
    });
  }

  closeModal.addEventListener('click', () => {
    joinModal.classList.add('hidden');
  });

  submitJoinBtn.addEventListener('click', () => {
    const code = roomCodeInput.value.trim().toUpperCase();
    if (code) {
      window.location.href = `/src/room.html?room=${code}`;
    } else {
      alert("Please enter a valid room code.");
    }
  });

  // Search Logic
  const homeSearchInput = document.getElementById('homeSearchInput');
  const homeSearchModal = document.getElementById('homeSearchModal');
  const closeSearchModal = document.getElementById('closeSearchModal');
  const homeSearchResults = document.getElementById('homeSearchResults');
  const YOUTUBE_API_KEY = 'AIzaSyDuz95QvhC2iLVXanoH1abBY7hbXyyYol8';

  if (homeSearchInput) {
    homeSearchInput.addEventListener('keypress', async (e) => {
      if (e.key === 'Enter') {
        const query = homeSearchInput.value.trim();
        if (!query) return;
        
        homeSearchModal.classList.remove('hidden');
        homeSearchResults.innerHTML = '<div style="text-align:center; padding: 20px;">Searching...</div>';
        
        try {
          const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=8&q=${encodeURIComponent(query)}&type=video&key=${YOUTUBE_API_KEY}`);
          const data = await res.json();
          homeSearchResults.innerHTML = '';
          
          if (!data.items || data.items.length === 0) {
            homeSearchResults.innerHTML = '<div style="text-align:center; padding: 20px;">No results found.</div>';
            return;
          }
          
          data.items.forEach(item => {
            const videoId = item.id.videoId;
            const title = item.snippet.title;
            const channel = item.snippet.channelTitle;
            const thumb = item.snippet.thumbnails.default.url;
            
            const card = document.createElement('div');
            card.className = 'home-song-card';
            card.style.cursor = 'default';
            card.innerHTML = `
              <img src="${thumb}" class="home-song-thumb" alt="Thumbnail">
              <div class="home-song-info">
                <div class="home-song-title">${title}</div>
                <div class="home-song-artist">${channel}</div>
              </div>
              <div style="display:flex; gap:8px;">
                <button class="btn play-btn" style="background:#6C63FF; color:white; border:none; padding:8px 12px; border-radius:12px; font-weight:700; cursor:pointer;">Play</button>
                <button class="btn add-btn" style="background:rgba(0,0,0,0.05); color:#0F0F1A; border:none; padding:8px 12px; border-radius:12px; font-weight:700; cursor:pointer;">Save</button>
              </div>
            `;
            
            const playBtn = card.querySelector('.play-btn');
            playBtn.addEventListener('click', () => {
              const roomCode = generateRoomCode();
              const songData = { videoId, title, artist: channel, thumb };
              sessionStorage.setItem('jam_initial_song', JSON.stringify(songData));
              window.location.href = `/src/room.html?room=${roomCode}&host=true`;
            });
            
            const addBtn = card.querySelector('.add-btn');
            addBtn.addEventListener('click', async () => {
              const currentUser = auth.currentUser;
              if (!currentUser) return;
              const playlistRef = ref(database, `users/${currentUser.uid}/playlist`);
              const newSongRef = push(playlistRef);
              await set(newSongRef, { videoId, title, artist: channel, thumbnail: thumb, addedAt: Date.now() });
              addBtn.textContent = 'Saved!';
              addBtn.style.background = '#10B981';
              addBtn.style.color = 'white';
              setTimeout(() => { addBtn.textContent = 'Save'; addBtn.style.background = 'rgba(0,0,0,0.05)'; addBtn.style.color = '#0F0F1A'; }, 2000);
            });
            
            homeSearchResults.appendChild(card);
          });
        } catch (error) {
          console.error(error);
          homeSearchResults.innerHTML = '<div style="text-align:center; padding: 20px;">Error searching YouTube.</div>';
        }
      }
    });
  }
  
  if (closeSearchModal) {
    closeSearchModal.addEventListener('click', () => {
      homeSearchModal.classList.add('hidden');
    });
  }
});
