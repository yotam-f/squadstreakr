import React, { useState, useEffect, useCallback } from 'react';
import { initializeApp } from "firebase/app";
import { 
  getAuth, 
  signInWithCustomToken, 
  signInAnonymously, 
  onAuthStateChanged, 
  signOut 
} from "firebase/auth";
import { 
  getFirestore, 
  doc, 
  setDoc, 
  getDoc, 
  updateDoc, 
  collection, 
  onSnapshot, 
  addDoc, 
  deleteDoc, 
  query, 
  where, 
  increment, 
  writeBatch, 
  getDocs, 
  runTransaction 
} from "firebase/firestore";
import { 
  Flame, 
  Snowflake, 
  CheckSquare, 
  Users as UsersIcon, 
  Settings, 
  Plus, 
  ChevronDown, 
  Check, 
  Circle, 
  CheckCircle, 
  X, 
  Copy, 
  LogOut 
} from 'lucide-react';

// --- Firebase Initialization ---
const firebaseConfig = JSON.parse(__firebase_config);
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'squadstreak-bb7b9';

const App = () => {
  const [user, setUser] = useState(null);
  const [userData, setUserData] = useState({});
  const [tasks, setTasks] = useState([]);
  const [group, setGroup] = useState(null);
  const [members, setMembers] = useState([]);
  const [memberTasks, setMemberTasks] = useState({});
  const [activeView, setActiveView] = useState('tasks');
  const [showOnlyToday, setShowOnlyToday] = useState(true);
  const [creatorExpanded, setCreatorExpanded] = useState(false);
  const [selectedDays, setSelectedDays] = useState([0, 1, 2, 3, 4, 5, 6]);
  const [toasts, setToasts] = useState([]);
  const [loading, setLoading] = useState(true);

  const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const today = new Date().getDay();
  const todayStr = new Date().toLocaleDateString('en-CA');

  // Helper: Toast
  const showToast = (msg) => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, msg }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 2500);
  };

  // 1. Auth Logic
  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (e) {
        console.error("Auth error", e);
      }
    };
    initAuth();
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (!u) setLoading(false);
    });
    return unsub;
  }, []);

  // 2. Initialize/Sync User Profile
  useEffect(() => {
    if (!user) return;

    const syncUser = async () => {
      const userRef = doc(db, "artifacts", appId, "users", user.uid);
      const snap = await getDoc(userRef);

      if (!snap.exists()) {
        await setDoc(userRef, { 
          name: user.displayName || 'Squad Member', 
          email: user.email || 'Anonymous', 
          groupId: null, 
          lastReset: todayStr 
        });
      } else {
        const data = snap.data();
        if (data.lastReset !== todayStr) {
          // Midnight Reset for personal task 'done' flags
          const taskSnaps = await getDocs(collection(db, "artifacts", appId, "users", user.uid, "tasks"));
          const batch = writeBatch(db);
          taskSnaps.forEach(tDoc => batch.update(tDoc.ref, { done: false }));
          batch.update(userRef, { lastReset: todayStr });
          await batch.commit();
        }
      }
    };

    syncUser();

    const unsubUser = onSnapshot(doc(db, "artifacts", appId, "users", user.uid), (snap) => {
      setUserData(snap.data() || {});
    });

    const unsubTasks = onSnapshot(collection(db, "artifacts", appId, "users", user.uid, "tasks"), (snap) => {
      setTasks(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });

    return () => { unsubUser(); unsubTasks(); };
  }, [user, todayStr]);

  // 3. Sync Group & Members
  useEffect(() => {
    if (!userData.groupId) {
      setGroup(null);
      setMembers([]);
      return;
    }

    const unsubGroup = onSnapshot(doc(db, "artifacts", appId, "public", "data", "groups", userData.groupId), (snap) => {
      if (snap.exists()) setGroup({ id: snap.id, ...snap.data() });
    });

    const unsubMembers = onSnapshot(query(collection(db, "artifacts", appId, "users"), where("groupId", "==", userData.groupId)), (snap) => {
      const mems = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setMembers(mems);
    });

    return () => { unsubGroup(); unsubMembers(); };
  }, [userData.groupId]);

  // 4. Sync Member Tasks (for progress tracking)
  useEffect(() => {
    if (members.length === 0) return;
    const unsubs = members.map(m => {
      return onSnapshot(collection(db, "artifacts", appId, "users", m.id, "tasks"), (snap) => {
        setMemberTasks(prev => ({
          ...prev,
          [m.id]: snap.docs.map(d => ({ id: d.id, ...d.data() }))
        }));
      });
    });
    return () => unsubs.forEach(fn => fn());
  }, [members]);

  // 5. STREAK LOGIC (Midnight + Freeze)
  useEffect(() => {
    if (!group || members.length === 0 || !memberTasks[user?.uid]) return;

    const processStreak = async () => {
      const groupRef = doc(db, "artifacts", appId, "public", "data", "groups", group.id);
      
      // Check if day has passed
      if (group.lastValidatedDate && group.lastValidatedDate !== todayStr) {
        
        // 1. Was yesterday successful?
        let yesterdayWasSuccess = true;
        const yesterdayDay = (new Date().getDay() + 6) % 7;

        for (const m of members) {
          const mTasks = memberTasks[m.id] || [];
          const yTasks = mTasks.filter(t => t.days?.includes(yesterdayDay));
          if (yTasks.length > 0 && !yTasks.every(t => t.done)) {
            yesterdayWasSuccess = false;
            break;
          }
        }

        // 2. Handle Outcome
        await runTransaction(db, async (transaction) => {
          const gSnap = await transaction.get(groupRef);
          const gData = gSnap.data();
          
          let newStreak = gData.streak || 0;
          let newFreezes = gData.freezes || 0;

          if (yesterdayWasSuccess) {
            newStreak += 1;
            // Every 7 days, get one more freeze
            if (newStreak > 0 && newStreak % 7 === 0) {
              newFreezes += 1;
              showToast("7 DAY REWARD: +1 FREEZE ❄️");
            }
          } else {
            // Use freeze if available
            if (newFreezes > 0) {
              newFreezes -= 1;
              newStreak += 1; // Streak continues but freeze consumed
              showToast("STREAK SAVED BY FREEZE ❄️");
            } else {
              newStreak = 0;
              showToast("STREAK BROKEN 💔");
            }
          }

          transaction.update(groupRef, {
            streak: newStreak,
            freezes: newFreezes,
            lastValidatedDate: todayStr
          });
        });
      }
    };

    processStreak();
  }, [group, members, memberTasks, todayStr, user?.uid]);

  // Actions
  const toggleTask = async (tid, status) => {
    await updateDoc(doc(db, "artifacts", appId, "users", user.uid, "tasks", tid), { done: !status });
  };

  const addTask = async (isGroup = false) => {
    const input = document.getElementById(isGroup ? 'group-task-in' : 'task-in');
    if (!input?.value.trim()) return;
    const title = input.value.trim();
    const days = isGroup ? [0,1,2,3,4,5,6] : [...selectedDays];

    if (isGroup) {
      const batchPromises = members.map(m => addDoc(collection(db, "artifacts", appId, "users", m.id, "tasks"), { 
        title: `[SQUAD] ${title}`, done: false, isSquad: true, days 
      }));
      await Promise.all(batchPromises);
      showToast("SQUAD TASK ADDED!");
    } else {
      await addDoc(collection(db, "artifacts", appId, "users", user.uid, "tasks"), { title, done: false, days });
      showToast("HABIT ADDED!");
    }
    input.value = ""; 
    setCreatorExpanded(false);
  };

  const createSquad = async () => {
    const name = prompt("Squad Name:");
    if (!name) return;
    const gRef = await addDoc(collection(db, "artifacts", appId, "public", "data", "groups"), { 
      name, 
      streak: 0, 
      freezes: 3, 
      lastValidatedDate: todayStr 
    });
    await updateDoc(doc(db, "artifacts", appId, "users", user.uid), { groupId: gRef.id });
  };

  const joinSquad = async () => {
    const id = prompt("Enter Squad ID:");
    if (!id) return;
    await updateDoc(doc(db, "artifacts", appId, "users", user.uid), { groupId: id });
  };

  const copyId = () => {
    const temp = document.createElement('input');
    temp.value = group.id;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand('copy');
    document.body.removeChild(temp);
    showToast("ID COPIED!");
  };

  if (loading) return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-white">
      <Flame className="w-20 h-20 text-orange-500 fill-orange-500 animate-pulse" />
      <span className="text-xs font-black text-orange-300 uppercase tracking-widest mt-4">Syncing...</span>
    </div>
  );

  return (
    <div className="min-h-screen bg-white text-black select-none">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 h-16 bg-white border-b-2 border-orange-100 flex items-center justify-between px-6 z-50">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full border-2 border-black overflow-hidden bg-gray-100">
            {user?.photoURL && <img src={user.photoURL} alt="pfp" className="w-full h-full object-cover" />}
          </div>
          <h1 className="font-black italic tracking-tighter text-xl text-orange-500 uppercase">SQUADSTREAK</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-blue-500 text-white px-3 py-1.5 rounded-full font-bold text-xs shadow-sm">
            <Snowflake className="w-3 h-3 fill-white" />
            <span>{group?.freezes || 0}</span>
          </div>
          <div className="flex items-center gap-1 bg-orange-500 text-white px-3 py-1.5 rounded-full font-bold text-xs shadow-sm">
            <Flame className="w-3 h-3 fill-white" />
            <span>{group?.streak || 0}</span>
          </div>
        </div>
      </header>

      {/* Main View */}
      <main className="pt-24 pb-72 px-6 max-w-md mx-auto min-h-screen">
        {activeView === 'tasks' && (
          <>
            <div className="flex justify-between items-center mb-8">
              <h2 className="text-4xl font-black italic tracking-tighter uppercase leading-none">Habits</h2>
              <button 
                onClick={() => setShowOnlyToday(!showOnlyToday)} 
                className={`text-[10px] font-black border-2 border-black px-4 py-2 rounded-xl transition-all ${showOnlyToday ? 'bg-black text-white' : 'bg-white'}`}
              >
                {showOnlyToday ? 'TODAY' : 'ALL'}
              </button>
            </div>
            
            <div className="space-y-4">
              {(showOnlyToday ? tasks.filter(t => t.days?.includes(today)) : tasks).map(t => (
                <div 
                  key={t.id}
                  onClick={() => toggleTask(t.id, t.done)}
                  className={`border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] p-5 rounded-[2rem] flex items-center gap-4 bg-white cursor-pointer active:translate-x-[2px] active:translate-y-[2px] active:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] transition-all ${t.done ? 'opacity-40' : ''}`}
                >
                  {t.done ? <CheckCircle className="text-orange-500" /> : <Circle className="text-gray-300" />}
                  <div className="flex-1">
                    <p className={`font-black text-sm uppercase ${t.done ? 'line-through' : ''}`}>{t.title}</p>
                    <p className="text-[8px] font-bold text-gray-400 uppercase tracking-widest mt-0.5">
                      {t.isSquad && <span className="text-orange-500 mr-1">SQUAD</span>}
                      {t.days?.length === 7 ? 'Every Day' : t.days?.map(d => dayLabels[d]).join(' ')}
                    </p>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); if(confirm("Delete?")) deleteDoc(doc(db, "artifacts", appId, "users", user.uid, "tasks", t.id)) }} className="p-2 text-gray-200 hover:text-red-500">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
              {tasks.length === 0 && <p className="text-center text-gray-300 font-bold py-10 uppercase text-xs">No habits today</p>}
            </div>

            {/* Floating Creator */}
            <div className={`fixed bottom-24 left-6 right-6 max-w-md mx-auto transition-all duration-300 ${!creatorExpanded ? 'translate-y-[220px] opacity-50' : ''}`}>
              <div className="bg-orange-500 p-6 rounded-[2.5rem] text-white shadow-2xl border-4 border-black/10 relative">
                <button 
                  onClick={() => setCreatorExpanded(!creatorExpanded)} 
                  className="absolute -top-10 left-1/2 -translate-x-1/2 bg-black w-16 h-7 rounded-full flex items-center justify-center"
                >
                  {creatorExpanded ? <ChevronDown /> : <Plus />}
                </button>
                <div className="flex justify-between mb-4">
                  {dayLabels.map((l, i) => (
                    <button 
                      key={i}
                      onClick={() => setSelectedDays(prev => prev.includes(i) ? prev.filter(d => d !== i) : [...prev, i])}
                      className={`w-8 h-8 rounded-xl font-black text-[10px] border border-white/30 ${selectedDays.includes(i) ? 'bg-white text-orange-500' : ''}`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input id="task-in" type="text" placeholder="I WILL..." className="flex-1 bg-white/20 rounded-2xl px-4 py-4 outline-none font-black placeholder:text-white/40 uppercase text-sm" />
                  <button onClick={() => addTask(false)} className="bg-white text-orange-500 w-14 rounded-2xl flex items-center justify-center">
                    <Check />
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {activeView === 'squad' && (
          <div className="space-y-6">
            {!group ? (
              <div className="text-center pt-20">
                <UsersIcon className="w-16 h-16 mx-auto mb-6 text-gray-200" />
                <h2 className="text-2xl font-black mb-8 uppercase italic tracking-tighter">No Squad</h2>
                <button onClick={createSquad} className="w-full bg-orange-500 text-white py-5 rounded-3xl font-black mb-4 shadow-lg uppercase">Start Squad</button>
                <button onClick={joinSquad} className="w-full border-4 border-black py-5 rounded-3xl font-black uppercase">Join with ID</button>
              </div>
            ) : (
              <>
                <div className="bg-black p-8 rounded-[3rem] text-white relative overflow-hidden">
                  <h2 className="text-4xl font-black italic uppercase leading-tight mb-1 tracking-tighter">{group.name}</h2>
                  <div className="flex items-center gap-4">
                    <p className="text-orange-500 text-2xl font-black">{group.streak || 0} DAY STREAK</p>
                    <div className="flex items-center gap-1 text-blue-400 font-black text-sm">
                      <Snowflake className="w-4 h-4" /> {group.freezes || 0}
                    </div>
                  </div>
                  <Flame className="absolute -bottom-6 -right-6 w-32 h-32 opacity-10 rotate-12 fill-white" />
                </div>

                <div className="bg-orange-50 border-2 border-orange-100 p-6 rounded-[2.5rem]">
                  <p className="text-[10px] font-black text-orange-800 uppercase mb-3 tracking-widest text-center">New Squad Habit</p>
                  <div className="flex gap-2">
                    <input id="group-task-in" type="text" placeholder="E.G. 50 PUSHUPS" className="flex-1 bg-white border-2 border-orange-100 rounded-2xl px-4 py-3 font-bold text-xs outline-none" />
                    <button onClick={() => addTask(true)} className="bg-orange-500 text-white p-3 rounded-xl"><Plus /></button>
                  </div>
                </div>

                <div className="space-y-3">
                  {members.map(m => {
                    const mt = (memberTasks[m.id] || []).filter(t => t.days?.includes(today));
                    const done = mt.filter(t => t.done).length;
                    const total = mt.length;
                    const pct = total > 0 ? (done/total)*100 : (mt.length > 0 ? 0 : 100);
                    return (
                      <div key={m.id} className="bg-white border-2 border-gray-50 p-4 rounded-[2rem] flex items-center gap-4">
                        <div className={`w-10 h-10 rounded-2xl flex items-center justify-center font-black ${pct === 100 ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-400'}`}>
                          {pct === 100 ? <Check className="w-5 h-5" /> : (m.name?.[0] || 'U').toUpperCase()}
                        </div>
                        <div className="flex-1">
                          <div className="flex justify-between text-[10px] font-black uppercase mb-1.5">
                            <span>{m.name || 'ANON'}</span>
                            <span className={pct === 100 ? 'text-orange-500' : 'text-gray-300'}>{done}/{total}</span>
                          </div>
                          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full bg-orange-500 transition-all duration-500" style={{ width: `${pct}%` }}></div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <button onClick={copyId} className="w-full mt-10 py-4 rounded-2xl border-2 border-dashed border-gray-200 text-gray-300 hover:text-black hover:border-black transition-all group">
                  <p className="text-[8px] font-black uppercase tracking-widest mb-1">Squad Invite ID</p>
                  <div className="flex items-center justify-center gap-2">
                    <span className="text-[10px] font-mono font-bold text-black">{group.id}</span>
                    <Copy className="w-3 h-3 text-orange-500" />
                  </div>
                </button>
              </>
            )}
          </div>
        )}

        {activeView === 'settings' && (
          <div className="space-y-4">
            <div className="bg-gray-50 p-10 rounded-[3rem] text-center">
              <p className="font-black text-2xl uppercase mb-1 tracking-tighter">{userData.name}</p>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{userData.email}</p>
            </div>
            <button 
              onClick={async () => { if(confirm("Leave squad?")) await updateDoc(doc(db, "artifacts", appId, "users", user.uid), { groupId: null }) }} 
              className="w-full bg-white border-2 border-black py-5 rounded-[2rem] font-black text-xs uppercase"
            >
              Leave Squad
            </button>
            <button 
              onClick={() => signOut(auth)} 
              className="w-full bg-red-50 text-red-500 py-5 rounded-[2rem] font-black text-xs uppercase tracking-widest flex items-center justify-center gap-2"
            >
              <LogOut className="w-4 h-4" /> Logout
            </button>
          </div>
        )}
      </main>

      {/* Nav */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t-4 border-black px-6 pt-4 pb-8 flex justify-around items-center z-50">
        <button onClick={() => setActiveView('tasks')} className={activeView === 'tasks' ? 'text-orange-500' : 'text-gray-300'}><CheckSquare /></button>
        <button onClick={() => setActiveView('squad')} className={activeView === 'squad' ? 'text-orange-500' : 'text-gray-300'}><UsersIcon /></button>
        <button onClick={() => setActiveView('settings')} className={activeView === 'settings' ? 'text-orange-500' : 'text-gray-300'}><Settings /></button>
      </nav>

      {/* Toasts */}
      <div className="fixed bottom-28 left-1/2 -translate-x-1/2 z-[200] pointer-events-none space-y-2">
        {toasts.map(t => (
          <div key={t.id} className="bg-black text-white px-6 py-3 rounded-full font-black text-[10px] uppercase shadow-xl animate-bounce">
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
};

export default App;