import {CloudConflict,sameVersion,validateDocument,documentBytes} from './sync-core.mjs';
const VERSION='13.0.0'; // Pinned to the version in Firebase's official web setup docs.
export async function loadFirebase(config){
 if(!config||config.projectId!=='gensokyo-rpg'||typeof config.apiKey!=='string'||!config.apiKey||typeof config.appId!=='string'||!config.appId||typeof config.authDomain!=='string'||!config.authDomain)throw new Error('Firebase 웹 앱 설정값이 아직 연결되지 않았습니다.');
 const base=`https://www.gstatic.com/firebasejs/${VERSION}/`;
 const [appSDK,authSDK,firestoreSDK]=await Promise.all([import(base+'firebase-app.js'),import(base+'firebase-auth.js'),import(base+'firebase-firestore.js')]);
 const app=appSDK.initializeApp(config,'gensokyo-rpg-cloud');
 const auth=authSDK.getAuth(app),db=firestoreSDK.getFirestore(app);
 const provider=new authSDK.GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});
 const ref=uid=>{if(typeof uid!=='string'||!uid||uid.includes('/'))throw new Error('올바르지 않은 로그인 UID');return firestoreSDK.doc(db,'users',uid);};
 return {auth,login:()=>authSDK.signInWithPopup(auth,provider),logout:()=>authSDK.signOut(auth),observe:callback=>authSDK.onAuthStateChanged(auth,callback),adapter:{
  async read(uid){if(auth.currentUser?.uid!==uid)throw new Error('로그인 계정 확인 실패');const snapshot=await firestoreSDK.getDocFromServer(ref(uid));return snapshot.exists()?snapshot.data():null;},
  async commit(uid,expected,raw,hash,device,guard){
   const record={schemaVersion:1,revision:(expected?.revision??0)+1,saveJson:raw,saveHash:hash,writerDevice:device,updatedAt:firestoreSDK.serverTimestamp()};
   if(documentBytes(uid,record)>=1024*1024)throw new Error('Firestore 문서 크기 제한을 초과했습니다.');
   return firestoreSDK.runTransaction(db,async transaction=>{guard();if(auth.currentUser?.uid!==uid)throw new Error('로그인 계정이 변경되었습니다.');const snapshot=await transaction.get(ref(uid));const current=await validateDocument(snapshot.exists()?snapshot.data():null);guard();
    if(!sameVersion(current,expected))throw new CloudConflict(current);
    transaction.set(ref(uid),record);return record;
   },{maxAttempts:5});
  }
 }};
}
