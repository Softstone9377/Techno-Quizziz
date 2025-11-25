// app.js — Techno-Quizziz Prototype v2 (Firebase-integrated)
// Usage: Replace firebaseConfig values and flip useFirebase = true to enable Firestore.
// Keep firebase SDK (compat) scripts loaded in index.html before this file.

(() => {
  // ---------- Config ----------
  const useFirebase = true; // set to false to disable Firebase and use localStorage-only
  // ---------- Helpers ----------
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const STORAGE = { DATA: 'tq_data_v2', USERS: 'tq_users_v2', SESSION: 'tq_session_v2' };
  const nowId = (p='id') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);

  function loadJSON(key, fallback){
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch(e){
      return fallback;
    }
  }
  function saveJSON(key, val){
    localStorage.setItem(key, JSON.stringify(val));
  }

  function escapeHtml(s){
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ---------- Elements ----------
  const landing = $('#landing');
  const auth = $('#auth');
  const teacher = $('#teacher');
  const student = $('#student');
  const quizPage = $('#quiz');
  const resultPage = $('#result');

  // ---------- Event wiring (will reference functions declared later) ----------
  // landing buttons
  $('#landing-teacher').addEventListener('click', () => openTeacherLanding());
  $('#landing-student').addEventListener('click', () => showSection('student'));
  $('#btn-teacher').addEventListener('click', () => openTeacherLanding());
  $('#btn-student').addEventListener('click', () => showSection('student'));
  $('#student-back').addEventListener('click', () => showSection('landing'));

  // auth buttons
  $('#open-signup').addEventListener('click', ()=> showAuth('signup'));
  $('#open-login').addEventListener('click', ()=> showAuth('login'));
  $('#auth-back').addEventListener('click', ()=> showSection('landing'));
  $('#auth-back-2').addEventListener('click', ()=> showSection('landing'));
  $('#show-signup').addEventListener('click', ()=> showAuth('signup'));
  $('#do-signup').addEventListener('click', doSignup);
  $('#do-login').addEventListener('click', doLogin);

  // teacher UI
  $('#btn-logout').addEventListener('click', logout);
  $('#add-set').addEventListener('click', addSet);
  $('#save-quiz').addEventListener('click', saveQuiz);
  $('#start-quiz').addEventListener('click', () => startQuizFromDraft()); // async-safe wrapper
  $('#add-q').addEventListener('click', addQuestion);
  $('#clear-q').addEventListener('click', clearQuestionBuilder);
  $('#end-quiz').addEventListener('click', () => endRoom()); // async-safe wrapper
  $('#export-results').addEventListener('click', exportLastRun);

  // student UI
  $('#join-room').addEventListener('click', () => studentJoin()); // async-safe wrapper
  $('#student-signup').addEventListener('click', ()=> showAuth('signup','student'));

  // quiz UI
  $('#submit-answer').addEventListener('click', () => submitAnswerHandler()); // async-safe wrapper
  $('#next-q').addEventListener('click', ()=> { $('#submit-answer').click(); });
  $('#ack-directions').addEventListener('click', ()=> {
    $('#set-directions-box').classList.add('hidden');
    loadQuestionForStudent(currentGlobalIndex);
  });

  $('#return-home').addEventListener('click', () => {
    localStateReset();
    showSection('landing');
  });

  // ---------- App state ----------
  let USERS = loadJSON(STORAGE.USERS, {}); // username -> {username, pass, role}
  let SESSION = loadJSON(STORAGE.SESSION, null); // {username, role}
  let APP = loadJSON(STORAGE.DATA, { quizzes: [], rooms: {}, records: [] });

  // draft and UI state for teacher
  let draft = { sets: [] };
  let selectedSetIndex = -1;

  // student-run state
  let currentRoom = null;
  let studentSession = null; // {playerId, name, roomCode}
  let questionOrder = []; // flattened
  let currentGlobalIndex = 0;
  let timerHandle = null;
  let remainingTime = 0;

  // ---------- Firebase integration ----------
  let db = null;
  let firebaseRoomUnsub = null;

  if(useFirebase){
    // <-- REPLACE with YOUR firebase config from console -->
    const firebaseConfig = {
      apiKey: "AIzaSyDtMHGuOXpXeHy5wFURbOJHV_K-8G76rkU",
      authDomain: "techno-quizziz.firebaseapp.com",
      projectId: "techno-quizziz",
      // storageBucket, messagingSenderId, appId are optional here
    };

    if(typeof firebase === 'undefined' || !firebase || !firebase.initializeApp){
      console.warn('Firebase not found. Make sure compat scripts are included in index.html before app.js');
    } else {
      firebase.initializeApp(firebaseConfig);
      db = firebase.firestore();
    }
  }

  // ---------- Firestore helpers ----------
  async function firebaseCreateRoom(quiz, classSection = 'Default') {
    if(!db) throw new Error('Firestore not initialized');
    let code = null;
    for(let tries=0; tries<6; tries++){
      code = String(Math.floor(1000 + Math.random()*9000));
      const snap = await db.collection('rooms').doc(code).get();
      if(!snap.exists) break;
      code = null;
    }
    if(!code) throw new Error('Could not generate unique room code');

    const roomDoc = {
      code,
      quizId: quiz.id,
      quizTitle: quiz.title,
      createdBy: SESSION ? SESSION.username : 'guest',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      status: 'open',
      quiz: quiz,
      classSection: classSection || 'Default'
    };
    await db.collection('rooms').doc(code).set(roomDoc);
    return code;
  }

  async function firebaseJoinRoom(code, playerId, playerName) {
    if(!db) throw new Error('Firestore not initialized');
    const roomRef = db.collection('rooms').doc(code);
    const roomSnap = await roomRef.get();
    if(!roomSnap.exists) throw new Error('Room not found or ended');
    const p = {
      id: playerId,
      name: playerName,
      score: 0,
      totalScore: 0,
      correctCount: 0,
      joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastUpdate: firebase.firestore.FieldValue.serverTimestamp()
    };
    await roomRef.collection('participants').doc(playerId).set(p);
    return roomSnap.data();
  }

  function firebaseListenRoom(code, onRoomUpdate, onParticipantsUpdate){
    if(!db) { console.warn('Firestore not initialized'); return null; }
    if(firebaseRoomUnsub) { firebaseRoomUnsub(); firebaseRoomUnsub = null; }

    const roomRef = db.collection('rooms').doc(code);

    const unsubRoom = roomRef.onSnapshot(snap => {
      const data = snap.exists ? snap.data() : null;
      onRoomUpdate && onRoomUpdate(data);
    });

    const unsubParts = roomRef.collection('participants').onSnapshot(snap => {
      const parts = [];
      snap.forEach(doc => parts.push(doc.data()));
      onParticipantsUpdate && onParticipantsUpdate(parts);
    });

    firebaseRoomUnsub = () => { unsubRoom(); unsubParts(); };
    return firebaseRoomUnsub;
  }

  async function firebaseUpdateParticipantScore(roomCode, playerId, updates = {}) {
    if(!db) throw new Error('Firestore not initialized');
    const pRef = db.collection('rooms').doc(roomCode).collection('participants').doc(playerId);
    const data = {
      ...updates,
      lastUpdate: firebase.firestore.FieldValue.serverTimestamp()
    };
    await pRef.set(data, { merge: true });
  }

  async function firebaseEndRoomAndSaveRecord(roomCode) {
    if(!db) throw new Error('Firestore not initialized');
    const roomRef = db.collection('rooms').doc(roomCode);
    const roomSnap = await roomRef.get();
    if(!roomSnap.exists) throw new Error('Room not found');
    const roomData = roomSnap.data();
    const partsSnap = await roomRef.collection('participants').get();
    const participants = [];
    partsSnap.forEach(d => participants.push(d.data()));
    const rec = {
      code: roomCode,
      quiz: roomData.quiz,
      createdBy: roomData.createdBy,
      classSection: roomData.classSection || 'Default',
      endedAt: firebase.firestore.FieldValue.serverTimestamp(),
      participants
    };
    const recRef = await db.collection('records').add(rec);
    await roomRef.update({ status: 'ended', endedAt: firebase.firestore.FieldValue.serverTimestamp() });
    return recRef.id;
  }

  // ---------- Initialization ----------
  renderLandingText();
  renderSets();
  renderQuizList();
  renderLiveRoom();
  renderRecords();
  restoreSession(); // auto-login if session exists

  // if there are rooms already, pick first as currentRoom for teacher display (local mirror)
  const rc = Object.keys(APP.rooms || {});
  if(rc.length) currentRoom = APP.rooms[rc[0]];
  renderLiveRoom();

  // ---------- UI functions ----------
  function showSection(name){
    [landing, auth, teacher, student, quizPage, resultPage].forEach(s => s.classList.add('hidden'));
    if(name === 'landing') landing.classList.remove('hidden');
    if(name === 'auth') auth.classList.remove('hidden');
    if(name === 'teacher') teacher.classList.remove('hidden');
    if(name === 'student') student.classList.remove('hidden');
    if(name === 'quiz') quizPage.classList.remove('hidden');
    if(name === 'result') resultPage.classList.remove('hidden');
  }

  function openTeacherLanding(){
    if(SESSION && SESSION.role === 'teacher') return showSection('teacher');
    showAuth('login','teacher');
  }

  function showAuth(mode='signup', forcedRole=null){
    showSection('auth');
    $('#auth-title').textContent = mode === 'signup' ? 'Create Account' : 'Login';
    document.getElementById('signup-form').classList.toggle('hidden', mode !== 'signup');
    document.getElementById('login-form').classList.toggle('hidden', mode !== 'login');
    if(forcedRole){
      document.getElementById('su-role').value = forcedRole;
    }
  }

  function doSignup(){
    const u = (document.getElementById('su-username').value || '').trim();
    const p = (document.getElementById('su-password').value || '').trim();
    const r = (document.getElementById('su-role').value || 'teacher');
    if(!u || !p) return alert('Enter username and password.');
    if(USERS[u]) return alert('Username already exists.');
    USERS[u] = { username: u, pass: p, role: r };
    saveJSON(STORAGE.USERS, USERS);
    alert('Account created. You can now log in.');
    SESSION = { username: u, role: r };
    saveJSON(STORAGE.SESSION, SESSION);
    restoreSession();
    showSection(r === 'teacher' ? 'teacher' : 'student');
  }

  function doLogin(){
    const u = (document.getElementById('li-username').value || '').trim();
    const p = (document.getElementById('li-password').value || '').trim();
    if(!u || !p) return alert('Enter username and password.');
    const account = USERS[u];
    if(!account || account.pass !== p) return alert('Invalid credentials.');
    SESSION = { username: u, role: account.role };
    saveJSON(STORAGE.SESSION, SESSION);
    restoreSession();
    alert('Logged in as ' + account.role);
    showSection(account.role === 'teacher' ? 'teacher' : 'student');
  }

  function logout(){
    SESSION = null;
    saveJSON(STORAGE.SESSION, null);
    alert('Logged out.');
    localStateReset();
    showSection('landing');
  }

  function restoreSession(){
    if(!SESSION) return;
    if(SESSION.role === 'teacher'){
      $('#teacher-welcome').textContent = `Welcome, ${SESSION.username} (Teacher)`;
      showSection('teacher');
    } else {
      $('#teacher-welcome').textContent = '';
    }
  }

  // ---------- Teacher: Sets & Questions ----------
  function addSet(){
    const title = (document.getElementById('set-title').value||'').trim();
    const dirs = (document.getElementById('set-directions').value||'').trim();
    const type = (document.getElementById('set-type').value||'mcq');
    draft.sets.push({ title, directions: dirs, type, questions: [] });
    document.getElementById('set-title').value=''; document.getElementById('set-directions').value=''; document.getElementById('set-type').value='mcq';
    renderSets(); saveApp();
  }

  function renderSets(){
    const list = document.getElementById('sets-list');
    list.innerHTML = '';
    if(draft.sets.length === 0){
      list.innerHTML = '<div class="muted">No sets yet. Add a set to start building questions.</div>';
      document.getElementById('qb-form').classList.add('hidden'); document.getElementById('no-set').classList.remove('hidden'); selectedSetIndex=-1;
      return;
    }
    draft.sets.forEach((s,i) => {
      const div = document.createElement('div');
      div.innerHTML = `<strong>${escapeHtml(s.title || 'Set ' + (i+1))}</strong>
        <div class="muted small">Type: ${s.type.toUpperCase()} · Questions: ${s.questions.length}</div>
        <div style="margin-top:8px">
          <button class="btn small" data-i="${i}">Select</button>
          <button class="btn outline small" data-i-del="${i}">Delete</button>
        </div>`;
      list.appendChild(div);
      setTimeout(()=> {
        const selBtn = div.querySelector('[data-i]');
        const delBtn = div.querySelector('[data-i-del]');
        if(selBtn) selBtn.onclick = () => { selectedSetIndex = i; renderSelectedSet(); };
        if(delBtn) delBtn.onclick = () => {
          if(confirm('Delete this set?')){ draft.sets.splice(i,1); selectedSetIndex=-1; renderSets(); saveApp(); }
        };
      },0);
    });
  }

  function renderSelectedSet(){
    if(selectedSetIndex < 0 || !draft.sets[selectedSetIndex]){
      document.getElementById('qb-form').classList.add('hidden'); document.getElementById('no-set').classList.remove('hidden');
      return;
    }
    document.getElementById('qb-form').classList.remove('hidden'); document.getElementById('no-set').classList.add('hidden');
    buildTypeFields(draft.sets[selectedSetIndex].type);
    renderQuestionsList();
  }

  function buildTypeFields(type){
    const tf = document.getElementById('type-fields');
    tf.innerHTML = '';
    if(type === 'mcq'){
      tf.innerHTML = `
        <label>Option A <input id="opt-a" class="opt" /></label>
        <label>Option B <input id="opt-b" class="opt" /></label>
        <label>Option C <input id="opt-c" class="opt" /></label>
        <label>Option D <input id="opt-d" class="opt" /></label>
        <label>Correct option
          <select id="q-correct"><option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="D">D</option></select>
        </label>`;
    } else if(type === 'tf'){
      tf.innerHTML = `<div class="muted small">True / False question. Correct option:
        <select id="q-correct"><option value="T">True</option><option value="F">False</option></select>
      </div>`;
    } else if(type === 'match'){
      tf.innerHTML = `
        <div id="match-pairs" class="small-card">
          <div id="pairs-list" class="list"></div>
          <label>Left item <input id="pair-left" /></label>
          <label>Right item (match) <input id="pair-right" /></label>
          <div class="row"><button id="add-pair" class="btn small">Add Pair</button></div>
        </div>
        <div class="muted small">When students take the quiz they'll match left items with dropdowns of right items.</div>`;
      setTimeout(()=> {
        const addPair = document.getElementById('add-pair');
        const left = document.getElementById('pair-left'); const right = document.getElementById('pair-right'); const listEl = document.getElementById('pairs-list');
        if(!document.getElementById('qb-form')._matchPairs) document.getElementById('qb-form')._matchPairs = [];
        function renderPairs(){
          listEl.innerHTML = '';
          document.getElementById('qb-form')._matchPairs.forEach((p, idx) => {
            const d = document.createElement('div');
            d.innerHTML = `<strong>${escapeHtml(p.left)}</strong> — ${escapeHtml(p.right)} <button class="btn outline small" data-del="${idx}">Del</button>`;
            listEl.appendChild(d);
            const btn = d.querySelector('button');
            if(btn) btn.onclick = () => { document.getElementById('qb-form')._matchPairs.splice(idx,1); renderPairs(); };
          });
        }
        addPair.onclick = () => {
          const L = (left.value||'').trim(), R = (right.value||'').trim();
          if(!L||!R) return alert('Fill both left and right items.');
          document.getElementById('qb-form')._matchPairs.push({ left:L, right:R });
          left.value=''; right.value=''; renderPairs();
        };
        renderPairs();
      },10);
    } else if(type === 'enum'){
      tf.innerHTML = `
        <label>Keywords (comma separated) — any match counts
          <input id="q-keywords" placeholder="e.g., router,gateway" />
        </label>
        <div class="muted small">Student will enter short answers; answers matched against keywords (case-insensitive).</div>`;
    } else if(type === 'essay'){
      tf.innerHTML = `<div class="muted small">Essay question. Student answer saved for teacher review.</div>`;
    } else {
      tf.innerHTML = `<div class="muted small">Unknown type.</div>`;
    }
  }

  function renderQuestionsList(){
    let container = document.getElementById('questions-list');
    if(!container){ container = document.createElement('div'); container.id='questions-list'; document.getElementById('qb-form').appendChild(container); }
    container.innerHTML = '<h4>Questions in this set</h4>';
    const list = document.createElement('div'); list.className='list';
    const s = draft.sets[selectedSetIndex];
    if(!s || !s.questions || s.questions.length===0){ list.innerHTML = '<div class="muted">No questions yet.</div>'; container.appendChild(list); return; }
    s.questions.forEach((q, qi) => {
      const d = document.createElement('div');
      d.innerHTML = `<strong>Q${qi+1}.</strong> ${escapeHtml(q.text)} <div class="muted small">(${escapeHtml(q.type.toUpperCase())})</div>
        <div style="margin-top:6px"><button class="btn small" data-edit="${qi}">Edit</button> <button class="btn outline small" data-del="${qi}">Delete</button></div>`;
      list.appendChild(d);
      setTimeout(()=> {
        const editBtn = d.querySelector('[data-edit]');
        const delBtn = d.querySelector('[data-del]');
        if(editBtn) editBtn.onclick = ()=> loadQuestionForEdit(qi);
        if(delBtn) delBtn.onclick = ()=> { if(confirm('Delete question?')){ s.questions.splice(qi,1); renderQuestionsList(); saveApp(); } };
      },0);
    });
    container.appendChild(list);
  }

  function addQuestion(){
    if(selectedSetIndex < 0) return alert('Select a set first.');
    const s = draft.sets[selectedSetIndex];
    const text = (document.getElementById('q-text').value||'').trim();
    if(!text) return alert('Question text required.');
    const q = { id: nowId('q'), type: s.type, text };
    if(s.type === 'mcq'){
      const A = (document.getElementById('opt-a').value||'').trim();
      const B = (document.getElementById('opt-b').value||'').trim();
      const C = (document.getElementById('opt-c').value||'').trim();
      const D = (document.getElementById('opt-d').value||'').trim();
      const correct = (document.getElementById('q-correct').value||'A');
      if(!A||!B||!C||!D) return alert('Fill all 4 options.');
      q.options = { A,B,C,D }; q.correct = correct;
    } else if(s.type === 'tf'){
      q.correct = (document.getElementById('q-correct').value||'T');
    } else if(s.type === 'match'){
      const pairs = (document.getElementById('qb-form')._matchPairs||[]).slice();
      if(pairs.length === 0) return alert('Add at least one pair.');
      q.pairs = pairs;
    } else if(s.type === 'enum'){
      const kw = (document.getElementById('q-keywords').value||'').trim();
      if(!kw) return alert('Enter keyword(s).');
      q.keywords = kw.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
    } else if(s.type === 'essay'){
      // nothing extra
    }
    s.questions.push(q);
    clearQuestionBuilder();
    renderQuestionsList(); saveApp();
  }

  function clearQuestionBuilder(){
    document.getElementById('q-text').value=''; 
    if(document.getElementById('qb-form')) document.getElementById('qb-form')._matchPairs = []; 
    if(selectedSetIndex>=0) buildTypeFields(draft.sets[selectedSetIndex].type);
  }

  function loadQuestionForEdit(qi){
    const s = draft.sets[selectedSetIndex];
    const q = s.questions[qi];
    if(!q) return;
    document.getElementById('q-text').value = q.text;
    buildTypeFields(q.type);
    setTimeout(()=> {
      if(q.type === 'mcq'){
        document.getElementById('opt-a').value = q.options.A || '';
        document.getElementById('opt-b').value = q.options.B || '';
        document.getElementById('opt-c').value = q.options.C || '';
        document.getElementById('opt-d').value = q.options.D || '';
        document.getElementById('q-correct').value = q.correct || 'A';
      } else if(q.type === 'tf'){
        document.getElementById('q-correct').value = q.correct || 'T';
      } else if(q.type === 'match'){
        if(document.getElementById('qb-form')) document.getElementById('qb-form')._matchPairs = (q.pairs||[]).slice();
        buildTypeFields('match');
      } else if(q.type === 'enum'){
        document.getElementById('q-keywords').value = (q.keywords||[]).join(',');
      }
    },50);
    s.questions.splice(qi,1);
    renderQuestionsList();
  }

  // ---------- Save / Start ----------
  function saveQuiz(){
    const title = (document.getElementById('quiz-title').value||'').trim();
    if(!title) return alert('Enter quiz title.');
    if(draft.sets.length === 0) return alert('Add at least one set.');
    for(const s of draft.sets) if(!s.questions || s.questions.length===0) return alert('Each set must have at least one question.');
    const quiz = { id: nowId('quiz'), title, timePer: Math.max(5,parseInt(document.getElementById('quiz-time').value)||30), sets: JSON.parse(JSON.stringify(draft.sets)), createdBy: SESSION ? SESSION.username : 'local' };
    APP.quizzes.push(quiz); saveApp();
    draft = { sets: [] }; selectedSetIndex=-1;
    document.getElementById('quiz-title').value=''; document.getElementById('quiz-time').value=30;
    renderSets(); renderQuizList();
    alert('Quiz saved.');
  }

  // ---------- Start live quiz (teacher) ----------
  async function startQuizFromDraft(){
    if(!SESSION || SESSION.role !== 'teacher') {
      if(!confirm('Start quiz as guest teacher? It is recommended to login as Teacher. Continue?')) return;
    }
    if(draft.sets.length === 0) return alert('Add at least one set (or load a saved quiz).');
    const quiz = { id: nowId('quiz'), title: document.getElementById('quiz-title').value || 'Live Quiz', timePer: Math.max(5,parseInt(document.getElementById('quiz-time').value)||30), sets: JSON.parse(JSON.stringify(draft.sets)), createdBy: SESSION ? SESSION.username : 'local' };
    APP.quizzes.push(quiz);
    saveApp();

    try {
      if(useFirebase && db){
        // optionally prompt for class section
        const classSection = prompt('Enter class section (optional)', 'Class_Default') || 'Class_Default';
        const code = await firebaseCreateRoom(quiz, classSection);
        currentRoom = { code, quiz };
        // subscribe
        firebaseListenRoom(code, (roomMeta)=> { currentRoom = currentRoom || {}; Object.assign(currentRoom, roomMeta); renderLiveRoom(); },
                               (participants)=> { if(currentRoom){ currentRoom.participants = {}; participants.forEach(p=> currentRoom.participants[p.id]=p); renderLiveRoom(); } });
        alert(`Room created. Students join with code: ${code}`);
        renderLiveRoom(); renderQuizList();
      } else {
        // local-only behavior (fallback)
        const room = createRoom(quiz);
        APP.rooms[room.code] = room;
        saveApp();
        currentRoom = room;
        alert(`Room created. Students join with code: ${room.code}`);
        renderLiveRoom(); renderQuizList();
      }
      // reset draft to allow reusing the UI
      draft = { sets: [] }; selectedSetIndex=-1;
    } catch(err){
      console.error(err);
      alert('Failed to create room: ' + (err.message || err));
    }
  }

  function createRoom(quiz){
    const code = String(Math.floor(1000 + Math.random()*9000));
    return { code, quiz, startedAt: Date.now(), participants: {} };
  }

  function renderQuizList(){
    const list = document.getElementById('quiz-list'); list.innerHTML = '';
    if(!APP.quizzes || APP.quizzes.length === 0){ list.innerHTML = '<div class="muted">No saved quizzes yet.</div>'; return; }
    APP.quizzes.slice().reverse().forEach(q => {
      const d = document.createElement('div');
      d.innerHTML = `<strong>${escapeHtml(q.title)}</strong>
        <div class="muted small">Sets: ${q.sets.length} · Time/q: ${q.timePer}s</div>
        <div style="margin-top:8px">
          <button class="btn small" data-id="${q.id}">Use</button>
          <button class="btn outline small" data-del="${q.id}">Delete</button>
        </div>`;
      list.appendChild(d);
      setTimeout(()=> {
        const useBtn = d.querySelector('[data-id]');
        const delBtn = d.querySelector('[data-del]');
        if(useBtn) useBtn.onclick = ()=> loadSavedToDraft(q.id);
        if(delBtn) delBtn.onclick = ()=> { if(confirm('Delete saved quiz?')){ APP.quizzes = APP.quizzes.filter(x=>x.id!==q.id); saveApp(); renderQuizList(); } };
      },0);
    });
  }

  function loadSavedToDraft(qid){
    const q = APP.quizzes.find(x=>x.id===qid); if(!q) return alert('Quiz not found.');
    draft = { sets: JSON.parse(JSON.stringify(q.sets)) };
    document.getElementById('quiz-title').value = q.title; document.getElementById('quiz-time').value = q.timePer;
    selectedSetIndex = -1; renderSets();
    alert('Loaded saved quiz to draft. Select a set to edit/add questions.');
  }

  // ---------- Live room rendering ----------
  function renderLiveRoom(){
    const liveRoom = document.getElementById('live-room'); const players = document.getElementById('live-players');
    if(!currentRoom){
      const codes = Object.keys(APP.rooms||{});
      if(codes.length) currentRoom = APP.rooms[codes[0]];
    }
    if(currentRoom){
      liveRoom.innerHTML = `<div><strong>Room ${escapeHtml(currentRoom.code)}</strong><div class="muted small">${escapeHtml((currentRoom.quiz && currentRoom.quiz.title) || '')}</div></div>`;
      players.innerHTML = '';
      const ps = currentRoom.participants ? Object.values(currentRoom.participants) : [];
      if(ps.length === 0) players.innerHTML = '<div class="muted small">No students connected yet.</div>';
      ps.forEach(p => {
        const el = document.createElement('div'); el.innerHTML = `<strong>${escapeHtml(p.name)}</strong> <div class="muted small">Score: ${p.score||0} ${p.pendingEssay ? '· Essay pending' : ''}</div>`;
        players.appendChild(el);
      });
    } else {
      liveRoom.innerHTML = '<div class="muted">No active room.</div>'; players.innerHTML = '';
    }
  }

  async function endRoom(){
    if(!currentRoom) return alert('No active room.');
    if(!confirm('End this room and record results?')) return;
    try {
      if(useFirebase && db){
        const recId = await firebaseEndRoomAndSaveRecord(currentRoom.code);
        if(firebaseRoomUnsub){ firebaseRoomUnsub(); firebaseRoomUnsub = null; }
        currentRoom = null;
        renderLiveRoom(); renderRecords();
        alert('Room ended and results recorded. Record id: ' + recId);
      } else {
        const rec = { id: nowId('rec'), code: currentRoom.code, quiz: currentRoom.quiz, endedAt: Date.now(), participants: Object.values(currentRoom.participants||{}) };
        APP.records = APP.records || []; APP.records.push(rec);
        delete APP.rooms[currentRoom.code]; currentRoom = null; saveApp();
        renderLiveRoom(); renderRecords();
        alert('Room ended and results recorded (local).');
      }
    } catch(err){
      console.error(err);
      alert('Failed to archive room: ' + (err.message || err));
    }
  }

  function exportLastRun(){
    if(useFirebase && db){
      alert('Use the Records panel to export Firestore records. (You can add an "Export" button that fetches records from Firestore.)');
      return;
    }
    if(!APP.records || APP.records.length===0) return alert('No runs recorded.');
    const last = APP.records[APP.records.length-1];
    const csv = toCSV(last);
    const blob = new Blob([csv], { type:'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `quiz_results_${last.code}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  function renderRecords(){
    const div = document.getElementById('records'); div.innerHTML = '';
    if(useFirebase && db){
      div.innerHTML = '<div class="muted small">Records are stored in Firestore. Use the Firestore console or add a fetch-records button to list them here.</div>';
      return;
    }
    if(!APP.records || APP.records.length===0){ div.innerHTML = '<div class="muted">No past runs recorded.</div>'; return; }
    APP.records.slice().reverse().forEach(r => {
      const d = document.createElement('div');
      d.innerHTML = `<strong>Room ${escapeHtml(r.code)} — ${escapeHtml(r.quiz.title)}</strong>
        <div class="muted small">${new Date(r.endedAt).toLocaleString()}</div>
        <div style="margin-top:8px">${(r.participants||[]).length} participants</div>
        <div style="margin-top:8px"><button class="btn small" data-view="${r.id}">View</button></div>`;
      div.appendChild(d);
      setTimeout(()=> { const btn = d.querySelector('[data-view]'); if(btn) btn.onclick = ()=> viewRecord(r); },0);
    });
  }

  function viewRecord(r){
    let out = `Results for ${r.quiz.title} (Room ${r.code})\nEnded: ${new Date(r.endedAt).toLocaleString()}\n\n`;
    (r.participants||[]).forEach(p => {
      out += `Name: ${p.name}\nScore: ${p.score||0}\nCorrect: ${p.correctCount||0}/${totalQuestions(r.quiz)}\n`;
      const essays = Object.entries(p.answers||{}).filter(([qid,a]) => a.type === 'essay');
      if(essays.length){
        out += '--- Essays ---\n';
        essays.forEach(([qid,a]) => { out += `${a.questionText || ''}\n${a.value || ''}\n----\n`; });
      }
      out += '\n';
    });
    alert(out);
  }

  // ---------- Student: join & quiz ----------
  async function studentJoin(){
    const name = (document.getElementById('student-name').value||'').trim();
    const code = (document.getElementById('student-code').value||'').trim();
    if(!name || !code) return alert('Enter name and room code.');

    if(useFirebase && db){
      try {
        const pid = nowId('p');
        const roomData = await firebaseJoinRoom(code, pid, name);
        studentSession = { playerId: pid, name, roomCode: code };
        currentRoom = { code, quiz: roomData.quiz };
        // listen for updates
        firebaseListenRoom(code, (roomMeta)=> { currentRoom = currentRoom || {}; Object.assign(currentRoom, roomMeta); renderLiveRoom(); },
                             (participants)=> { if(currentRoom){ currentRoom.participants = {}; participants.forEach(p=> currentRoom.participants[p.id]=p); renderLiveRoom(); } });
        buildQuestionOrder(currentRoom.quiz);
        showSection('quiz');
        document.getElementById('quiz-title-display').textContent = currentRoom.quiz.title;
        document.getElementById('quiz-room-display').textContent = `Room ${code}`;
        document.getElementById('q-total').textContent = questionOrder.length || 1;
        currentGlobalIndex = 0;
        showNextQuestionOrDirections();
        renderLiveRoom();
      } catch(err){
        alert('Join failed: ' + (err.message || err));
      }
    } else {
      // local fallback
      const room = APP.rooms && APP.rooms[code];
      if(!room) return alert('Room not found or ended.');
      const pid = nowId('p');
      room.participants[pid] = { id: pid, name, score: 0, correctCount: 0, answers: {}, pendingEssay: false };
      saveApp();
      currentRoom = room;
      studentSession = { playerId: pid, name, roomCode: code };
      buildQuestionOrder(room.quiz);
      showSection('quiz');
      document.getElementById('quiz-title-display').textContent = room.quiz.title;
      document.getElementById('quiz-room-display').textContent = `Room ${room.code}`;
      document.getElementById('q-total').textContent = questionOrder.length || 1;
      currentGlobalIndex = 0;
      showNextQuestionOrDirections();
      renderLiveRoom();
    }
  }

  function buildQuestionOrder(quiz){
    questionOrder = [];
    quiz.sets.forEach((s, si) => s.questions.forEach((q, qi)=> questionOrder.push({ setIndex: si, qIndex: qi })));
  }

  function showNextQuestionOrDirections(){
    if(currentGlobalIndex >= questionOrder.length) return finishStudentQuiz();
    const entry = questionOrder[currentGlobalIndex];
    const setObj = currentRoom.quiz.sets[entry.setIndex];
    const isFirstInSet = currentGlobalIndex === 0 || questionOrder[currentGlobalIndex-1].setIndex !== entry.setIndex;
    if(isFirstInSet && (setObj.directions||'').trim()){
      $('#set-title-display').textContent = setObj.title || `Set ${entry.setIndex+1}`;
      $('#set-directions-display').textContent = setObj.directions;
      $('#set-directions-box').classList.remove('hidden');
    } else {
      loadQuestionForStudent(currentGlobalIndex);
    }
  }

  function loadQuestionForStudent(globalIndex){
    clearInterval(timerHandle);
    const entry = questionOrder[globalIndex];
    const setObj = currentRoom.quiz.sets[entry.setIndex];
    const q = setObj.questions[entry.qIndex];
    $('#q-index').textContent = (globalIndex+1);
    $('#q-text-display').textContent = q.text;
    $('#q-options').innerHTML = '';
    $('#q-feedback').textContent = '';
    remainingTime = currentRoom.quiz.timePer;
    $('#q-timer').textContent = remainingTime;
    $('#q-total').textContent = questionOrder.length || 1;

    if(q.type === 'mcq'){
      Object.entries(q.options || {}).forEach(([k,v])=>{
        const b = document.createElement('button'); b.className='opt-btn'; b.dataset.opt=k;
        b.innerHTML = `<strong>${escapeHtml(k)}</strong>. ${escapeHtml(v)}`;
        b.onclick = ()=> { $$('#q-options .opt-btn').forEach(x=>x.classList.remove('selected')); b.classList.add('selected'); };
        document.getElementById('q-options').appendChild(b);
      });
    } else if(q.type === 'tf'){
      ['T','F'].forEach(k=>{
        const text = k==='T' ? 'True' : 'False';
        const b = document.createElement('button'); b.className='opt-btn'; b.dataset.opt=k; b.innerHTML = `<strong>${k}</strong>. ${text}`;
        b.onclick = ()=> { $$('#q-options .opt-btn').forEach(x=>x.classList.remove('selected')); b.classList.add('selected'); };
        document.getElementById('q-options').appendChild(b);
      });
    } else if(q.type === 'match'){
      const rights = (q.pairs || []).map(p=>p.right);
      q.pairs.forEach((p, idx) => {
        const row = document.createElement('div'); row.className = 'match-row';
        const left = document.createElement('div'); left.className='match-left'; left.textContent = p.left;
        const sel = document.createElement('select'); sel.className='match-right';
        const empty = document.createElement('option'); empty.value=''; empty.textContent='Select match'; sel.appendChild(empty);
        rights.slice().forEach(opt => { const o = document.createElement('option'); o.value = opt; o.textContent = opt; sel.appendChild(o); });
        row.appendChild(left); row.appendChild(sel); document.getElementById('q-options').appendChild(row);
      });
    } else if(q.type === 'enum'){
      const count = Math.max(1, Math.min(5, (q.keywords||[]).length || 1));
      for(let i=0;i<count;i++){
        const inp = document.createElement('input');
        inp.placeholder = `Answer ${i+1}`;
        inp.style.padding='10px';
        inp.style.borderRadius='8px';
        inp.style.border='1px solid #e6eefb';
        document.getElementById('q-options').appendChild(inp);
      }
    } else if(q.type === 'essay'){
      const ta = document.createElement('textarea'); ta.placeholder = 'Write your essay answer here...'; ta.style.minHeight='120px'; document.getElementById('q-options').appendChild(ta);
    }

    timerHandle = setInterval(()=> {
      remainingTime--; $('#q-timer').textContent = remainingTime;
      if(remainingTime <= 0){ clearInterval(timerHandle); autoSubmit(); }
    },1000);
  }

  function autoSubmit(){ $('#submit-answer').click(); }

  // ---------- Submit answer handler (async because it may call Firebase) ----------
  async function submitAnswerHandler(){
    if(!studentSession || !currentRoom) return alert('No active session.');
    const pid = studentSession.playerId;
    // For firebase path, we'll keep a local copy of the player while updating Firestore
    let player = (currentRoom.participants && currentRoom.participants[pid]) || { id: pid, name: studentSession.name, score:0, correctCount:0, answers: {} };
    const entry = questionOrder[currentGlobalIndex];
    const setObj = currentRoom.quiz.sets[entry.setIndex];
    const q = setObj.questions[entry.qIndex];
    const record = { type: q.type, questionText: q.text, value: null, isCorrect: false };

    if(q.type === 'mcq' || q.type === 'tf'){
      const sel = document.querySelector('#q-options .opt-btn.selected');
      const chosen = sel ? sel.dataset.opt : null;
      record.value = chosen;
      record.isCorrect = !!chosen && chosen === q.correct;
      if(record.isCorrect){ player.score = (player.score||0) + 1; player.correctCount = (player.correctCount||0) + 1; }
    } else if(q.type === 'match'){
      const selects = document.querySelectorAll('#q-options select');
      let correctCnt = 0; const details = [];
      (q.pairs||[]).forEach((p, idx) => {
        const sel = selects[idx]; const val = sel ? sel.value : '';
        if(val && val === p.right) correctCnt++;
        details.push({ left: p.left, chosen: val || '', expected: p.right });
      });
      record.value = details; record.isCorrect = (correctCnt === (q.pairs||[]).length);
      if(record.isCorrect){ player.score = (player.score||0) + 1; player.correctCount = (player.correctCount||0) + 1; }
    } else if(q.type === 'enum'){
      const inputs = Array.from(document.querySelectorAll('#q-options input')).map(i=> (i.value||'').trim().toLowerCase()).filter(Boolean);
      const keywords = (q.keywords||[]).map(x=>x.toLowerCase());
      const matched = inputs.some(inp => keywords.some(kw => inp.includes(kw) || kw.includes(inp)));
      record.value = inputs; record.isCorrect = matched;
      if(matched){ player.score = (player.score||0) + 1; player.correctCount = (player.correctCount||0) + 1; }
    } else if(q.type === 'essay'){
      const ta = document.querySelector('#q-options textarea'); const txt = ta ? (ta.value||'').trim() : '';
      record.value = txt; record.isCorrect = null; player.pendingEssay = true; record.pending = true;
    }

    if(!player.answers) player.answers = {};
    player.answers[q.id] = record;
    // optional: update player's totalScore field — here totalScore is the running score
    player.totalScore = player.score || 0;

    // Persist locally
    if(!currentRoom.participants) currentRoom.participants = {};
    currentRoom.participants[pid] = player;
    saveApp();
    renderLiveRoom();

    // Update Firestore participant doc (if enabled)
    if(useFirebase && db){
      try {
        await firebaseUpdateParticipantScore(currentRoom.code, pid, {
          name: player.name,
          score: player.score || 0,
          totalScore: player.totalScore || 0,
          correctCount: player.correctCount || 0,
          // Avoid writing full answers map to a single doc if it can be large; optional:
          // answersSummary: Object.keys(player.answers).length
        });
      } catch(err){
        console.error('Failed to update Firestore participant:', err);
      }
    }

    // show feedback
    if(q.type === 'essay'){
      $('#q-feedback').textContent = 'Essay recorded — teacher will review this answer.';
    } else {
      $('#q-feedback').textContent = record.value === null ? 'No answer.' : (record.isCorrect ? 'Correct ✅' : `Wrong — correct: ${q.correct || 'See teacher'}`);
    }

    clearInterval(timerHandle);
    setTimeout(()=> {
      currentGlobalIndex++;
      if(currentGlobalIndex < questionOrder.length) showNextQuestionOrDirections();
      else finishStudentQuiz();
    }, 900);
  }

  function finishStudentQuiz(){
    const pid = studentSession.playerId; const player = currentRoom.participants[pid];
    showSection('result');
    document.getElementById('final-score').textContent = `${player.name} — Score: ${player.score || 0} / ${questionOrder.length}`;
    document.getElementById('final-details').textContent = `Correct: ${player.correctCount || 0}. Responses saved to Room ${currentRoom.code}.`;
    studentSession = null; saveApp();
  }

  // ---------- Utils & storage ----------
  function saveApp(){ saveJSON(STORAGE.DATA, APP); }

  function totalQuestions(quiz){ return (quiz.sets || []).reduce((s,set)=> s + ((set.questions||[]).length), 0); }

  function toCSV(record){
    const rows=[]; 
    rows.push(['Room', record.code]); 
    rows.push(['Quiz', record.quiz.title]); 
    rows.push(['Ended At', new Date(record.endedAt).toLocaleString()]); 
    rows.push([]);
    rows.push(['Name','Score','CorrectCount','Answers']);
    (record.participants||[]).forEach(p => {
      const ansParts = [];
      for(const [qid,a] of Object.entries(p.answers||{})){
        let outVal='';
        if(a.type === 'essay') outVal = `ESSAY: ${a.value || ''}`;
        else if(a.type === 'match') outVal = (a.value || []).map(x=>`${x.left}->${x.chosen}`).join('|');
        else if(Array.isArray(a.value)) outVal = a.value.join('|');
        else outVal = String(a.value || '');
        const qLabel = a.questionText || qid;
        ansParts.push(`${qLabel}::${outVal}`);
      }
      rows.push([p.name, p.score||0, p.correctCount||0, ansParts.join(' || ')]);
    });
    return rows.map(r => r.map(f => `"${String(f).replace(/"/g,'""')}"`).join(',')).join('\n');
  }

  function localStateReset(){
    studentSession = null; currentRoom = null; questionOrder = []; currentGlobalIndex = 0; clearInterval(timerHandle);
  }

  // ---------- small demo data (only if none) ----------
  if(!APP.quizzes || APP.quizzes.length === 0){
    APP.quizzes = [{
      id:'demo1', title:'Demo: ICT Basics (v2)', timePer:20, sets:[
        { title:'Set 1 - MCQ', directions:'Choose the single best answer.', type:'mcq', questions:[
          { id:'d1', type:'mcq', text:'What does HTTP stand for?', options:{A:'Hyper Text Transfer Protocol',B:'Hyperlink Text Transport Protocol',C:'High Transfer Text Protocol',D:'Hyper Text Transfer Process'}, correct:'A' },
          { id:'d2', type:'mcq', text:'Which device forwards packets between networks?', options:{A:'Switch',B:'Router',C:'Modem',D:'Hub'}, correct:'B' },
        ]},
        { title:'Set 2 - TF', directions:'True/False', type:'tf', questions:[
          { id:'d3', type:'tf', text:'A router connects multiple networks.', correct:'T' }
        ]},
        { title:'Set 3 - Matching', directions:'Match left to right.', type:'match', questions:[
          { id:'d4', type:'match', text:'Match component to function.', pairs:[{left:'Keyboard', right:'Input device'},{left:'Monitor', right:'Output device'}] }
        ]}
      ]
    }];
    saveApp();
  }

  // ---------- small helpers used in UI initial render ----------
  function renderLandingText(){
    // nothing dynamic to do — landing HTML handles the centered text
  }

})();
