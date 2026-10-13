export const SAVE_KEY='gensokyo-rpg:permanent';
export const LIMIT=900*1024; // Conservative headroom for Firestore's 1 MiB document limit.
const encoder=new TextEncoder();
export function validateSave(raw){
 if(typeof raw!=='string'||encoder.encode(raw).length>LIMIT)throw new Error('저장 기록이 허용 크기를 초과하거나 형식이 잘못되었습니다. 로컬 기록은 유지됩니다.');
 const value=JSON.parse(raw);
 if(!value||Array.isArray(value)||value.saveVersion!==1)throw new Error('지원하지 않는 게임 저장 형식입니다.');
 const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
 if(value.resources!==undefined){if(!object(value.resources))throw new Error('재화 데이터 형식 오류');for(const k of ['bongma','money'])if(value.resources[k]!==undefined&&(!Number.isSafeInteger(value.resources[k])||value.resources[k]<0))throw new Error('재화 데이터 값 오류');}
 for(const k of ['inventory','farm','vocabulary','regionStages','story','relationships','dungeons'])if(value[k]!==undefined&&!object(value[k]))throw new Error('저장 데이터 형식 오류: '+k);
 if(value.farm?.plots!==undefined&&(!Array.isArray(value.farm.plots)||value.farm.plots.length!==6))throw new Error('밭 저장 데이터 형식 오류');
 for(const counts of [value.inventory?.items,value.farm?.seeds,value.farm?.produce])if(counts!==undefined){if(!object(counts)||Object.values(counts).some(n=>!Number.isSafeInteger(n)||n<0))throw new Error('아이템 수량 데이터 형식 오류');}
 if(value.regionStages?.cleared!==undefined&&(!Array.isArray(value.regionStages.cleared)||value.regionStages.cleared.length!==5||value.regionStages.cleared.some(n=>typeof n!=='boolean')))throw new Error('스테이지 클리어 데이터 형식 오류');
 const visit=(v,depth=0)=>{if(depth>40)throw new Error('저장 데이터 깊이 초과');if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)){if(k==='__proto__')throw new Error('안전하지 않은 저장 키');visit(x,depth+1);}};visit(value);
 return value;
}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
export async function saveHash(raw){validateSave(raw);const bytes=encoder.encode(JSON.stringify(canonical(JSON.parse(raw))));return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export function documentBytes(uid,doc){let size=encoder.encode('users').length+1+encoder.encode(uid).length+1+16+32;for(const[k,v]of Object.entries(doc)){size+=encoder.encode(k).length+1;size+=typeof v==='string'?encoder.encode(v).length+1:8;}return size;}
export async function validateDocument(doc){if(doc===null)return null;if(!doc||doc.schemaVersion!==1||!Number.isSafeInteger(doc.revision)||doc.revision<1||typeof doc.saveHash!=='string'||!/^[a-f0-9]{64}$/.test(doc.saveHash))throw new Error('클라우드 기록 형식을 확인할 수 없습니다. 백업 후 점검이 필요합니다.');validateSave(doc.saveJson);if(await saveHash(doc.saveJson)!==doc.saveHash)throw new Error('클라우드 기록 무결성 검사 실패');return doc;}
export function sameVersion(a,b){return a===null&&b===null||!!a&&!!b&&a.revision===b.revision&&a.saveHash===b.saveHash;}
export class CloudConflict extends Error{constructor(remote){super('다른 기기에서 클라우드 기록이 변경되었습니다.');this.name='CloudConflict';this.remote=remote;}}
export class CloudSync{
 constructor({storage,adapter,install,onState=()=>{},online=()=>true,now=()=>Date.now(),schedule=setTimeout,cancel=clearTimeout,deviceId=crypto.randomUUID()}){Object.assign(this,{storage,adapter,install,onState,online,now,schedule,cancel,deviceId});this.uid=null;this.epoch=0;this.remote=null;this.conflict=null;this.ready=false;this.busy=false;this.timer=null;this.dirty=false;this.lastWrite=0;this.retryDelay=30000;this.nextAttempt=0;this.dirtySince=null;this.seenRaw=undefined;this.status='로그인 없이 로컬 저장으로 플레이할 수 있어요.';}
 emit(message){if(message)this.status=message;this.onState({uid:this.uid,ready:this.ready,busy:this.busy,conflict:this.conflict,status:this.status,dirty:this.dirty});}
 readLocal(){return this.storage.getItem(SAVE_KEY);}
 guard(epoch,uid){if(epoch!==this.epoch||uid!==this.uid)throw new Error('로그인 계정이 바뀌어 요청을 중단했습니다.');}
 clearTimer(){if(this.timer!==null)this.cancel(this.timer);this.timer=null;}
 async connect(uid){this.clearTimer();const epoch=++this.epoch;this.uid=uid;this.busy=false;this.nextAttempt=0;this.ready=false;this.conflict=null;this.remote=null;this.emit(uid?'클라우드 기록을 확인하고 있어요.':'로그아웃했어요. 로컬 기록은 유지됩니다.');if(!uid)return;
  this.busy=true;this.emit();try{const remote=await validateDocument(await this.adapter.read(uid));this.guard(epoch,uid);const local=this.readLocal();if(local!==null)validateSave(local);const hash=local!==null?await saveHash(local):null;this.guard(epoch,uid);this.remote=remote;
   if(this.readLocal()!==local){this.conflict={local:this.readLocal(),remote,reason:'기록 확인 중 로컬 진행이 바뀌었어요. 최신 기록을 확인하고 선택해주세요.'};this.emit(this.conflict.reason);}
   else if(local!==null&&remote&&hash===remote.saveHash){this.ready=true;this.dirty=false;this.emit('로컬과 클라우드 기록이 같아요. 자동 동기화를 사용할 수 있습니다.');}
   else if(local===null&&remote===null){this.ready=true;this.dirty=false;this.emit('아직 저장 기록이 없어요. 앞으로 저장되는 진행을 동기화합니다.');}
   else{this.conflict={local,remote,reason:remote?'사용할 기록을 선택해주세요. 선택 전에는 어느 쪽도 덮어쓰지 않습니다.':'처음 업로드할 로컬 기록을 확인해주세요.'};this.emit(this.conflict.reason);}
  }catch(error){if(epoch===this.epoch)this.emit('클라우드 확인 실패: '+error.message+' 로컬 플레이는 계속할 수 있어요.');}finally{if(epoch===this.epoch){this.busy=false;this.emit();}}
 }
 disconnect(){this.clearTimer();this.epoch++;this.uid=null;this.busy=false;this.ready=false;this.conflict=null;this.remote=null;this.emit('로그아웃했어요. 로컬 기록은 유지됩니다.');}
 backup(local,remote){const entry={format:'gensokyo-cloud-backup',createdAt:this.now(),uid:this.uid,local,cloud:remote?.saveJson??null,revision:remote?.revision??null};this.storage.setItem('gensokyo-rpg:cloud-backup',JSON.stringify(entry));return entry;}
 async makeConflict(remote,reason){const epoch=this.epoch;await validateDocument(remote);if(epoch!==this.epoch)return;this.remote=remote;this.ready=false;this.clearTimer();this.conflict={local:this.readLocal(),remote,reason};this.emit(reason);}
 async choose(which){if(!this.uid||this.busy||!this.conflict)return false;const epoch=this.epoch,uid=this.uid,shown=this.conflict;this.busy=true;this.emit();try{
   const remote=await validateDocument(await this.adapter.read(uid));this.guard(epoch,uid);const local=this.readLocal();if(local!==null)validateSave(local);
   if(!sameVersion(remote,shown.remote)||local!==shown.local){await this.makeConflict(remote,'선택 화면을 연 뒤 기록이 바뀌었어요. 최신 기록을 확인하고 다시 선택해주세요.');return false;}
   this.backup(local,remote); // A failed backup blocks replacement.
   if(which==='cloud'){if(!remote)return false;this.guard(epoch,uid);await this.install(remote.saveJson,local);this.guard(epoch,uid);this.remote=remote;this.conflict=null;this.ready=true;this.dirty=false;this.emit('클라우드 기록을 불러왔어요. 게임을 새로고침합니다.');return true;}
   if(which!=='local'||local===null)return false;
   const hash=await saveHash(local);this.guard(epoch,uid);const next=await this.adapter.commit(uid,remote,local,hash,this.deviceId,()=>this.guard(epoch,uid));this.guard(epoch,uid);await validateDocument(next);this.guard(epoch,uid);this.remote=next;this.conflict=null;this.ready=true;this.lastWrite=this.now();this.dirty=this.readLocal()!==local;this.emit('선택한 로컬 기록을 클라우드에 저장했어요.');if(this.dirty){this.seenRaw=undefined;this.localChanged();}return true;
  }catch(error){if(epoch===this.epoch){if(error instanceof CloudConflict)await this.makeConflict(error.remote,error.message);else this.emit('기록 적용 실패: '+error.message+' 기존 기록은 유지됩니다.');}return false;}finally{if(epoch===this.epoch){this.busy=false;this.emit();}}
 }
 localChanged(){const raw=this.readLocal();if(raw===this.seenRaw)return;this.seenRaw=raw;this.dirty=true;this.dirtySince??=this.now();if(!this.uid||!this.ready||this.conflict)return;this.clearTimer();const wait=Math.max(0,this.nextAttempt-this.now(),30000-(this.now()-this.lastWrite),Math.min(8000,30000-(this.now()-this.dirtySince)));this.timer=this.schedule(()=>{this.timer=null;void this.flush();},wait);this.emit('로컬 저장 완료 · 클라우드 동기화 대기 중');}
 async flush({manual=false}={}){if(!this.uid||!this.ready||this.busy||this.conflict)return false;this.clearTimer();if(!manual&&this.now()<this.nextAttempt){this.timer=this.schedule(()=>{this.timer=null;void this.flush();},this.nextAttempt-this.now());return false;}if(!this.online()){this.dirty=true;this.emit('오프라인이에요. 로컬 기록을 유지하고 연결 후 다시 저장합니다.');return false;}
  const epoch=this.epoch,uid=this.uid,local=this.readLocal();if(local===null)return false;this.busy=true;this.emit('클라우드에 저장하고 있어요.');try{const hash=await saveHash(local);this.guard(epoch,uid);if(this.remote?.saveHash===hash){if(manual){const latest=await validateDocument(await this.adapter.read(uid));this.guard(epoch,uid);if(!sameVersion(latest,this.remote)){await this.makeConflict(latest,'다른 기기의 클라우드 기록이 바뀌었어요. 사용할 기록을 선택해주세요.');return false;}}this.dirty=this.readLocal()!==local;this.dirtySince=null;this.emit('변경된 기록이 없어요.');if(this.dirty){this.seenRaw=undefined;this.localChanged();}return true;}
   const next=await this.adapter.commit(uid,this.remote,local,hash,this.deviceId,()=>this.guard(epoch,uid));this.guard(epoch,uid);await validateDocument(next);this.guard(epoch,uid);this.remote=next;this.lastWrite=this.now();this.retryDelay=30000;this.nextAttempt=0;this.dirtySince=null;this.dirty=this.readLocal()!==local;this.emit('클라우드 저장 완료');if(this.dirty){this.seenRaw=undefined;this.localChanged();}return true;
  }catch(error){if(epoch===this.epoch){this.dirty=true;if(error instanceof CloudConflict)await this.makeConflict(error.remote,error.message);else{this.emit('클라우드 저장 실패 · 로컬 기록은 유지됩니다. '+error.message);this.retryDelay=Math.min(this.retryDelay*2,300000);this.nextAttempt=this.now()+this.retryDelay;this.timer=this.schedule(()=>{this.timer=null;void this.flush();},this.retryDelay);}}return false;}finally{if(epoch===this.epoch){this.busy=false;this.emit();}}
 }
}
