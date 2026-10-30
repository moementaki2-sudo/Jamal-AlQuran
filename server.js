const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:true, limit:'2mb'}));

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT,'data');
const UPLOAD_DIR = path.join(ROOT,'uploads');
const VIDEO_DIR = path.join(UPLOAD_DIR,'videos');
const REC_DIR = path.join(UPLOAD_DIR,'recitations');
const DB_FILE = path.join(DATA_DIR,'db.json');
for (const d of [DATA_DIR,UPLOAD_DIR,VIDEO_DIR,REC_DIR]) fs.mkdirSync(d,{recursive:true});

const contestants = ['فؤاد مصطفى','صلاح','إسلام شطا','مؤمن تقي','محمد شطا','محمد القاسم','إياد أيمن','عمر مصطفى','بلال حسين','عمر علاء'];
const defaultCodes = {'فؤاد مصطفى':'FQ731','صلاح':'SL284','إسلام شطا':'IS619','مؤمن تقي':'MT452','محمد شطا':'MS837','محمد القاسم':'MQ306','إياد أيمن':'EA574','عمر مصطفى':'OM921','بلال حسين':'BH648','عمر علاء':'OA175'};
const adminNames = new Set((process.env.ADMIN_NAMES || 'مؤمن تقي,محمد شطا').split(',').map(s=>s.trim()).filter(Boolean));
function codeFor(name){
  const envKey='CODE_'+name.replace(/\s+/g,'_');
  return process.env[envKey] || defaultCodes[name];
}

function initialMatches(){
  const pairs=[[contestants[0],contestants[1]],[contestants[2],contestants[3]],[contestants[4],contestants[5]],[contestants[6],contestants[7]],[contestants[8],contestants[9]]];
  return pairs.map((p,i)=>match(`1-${i+1}`,1,`المواجهة ${i+1}`,p));
}
function match(id,round,label,players=[null,null]){return {id,round,label,players,votes:{},winner:null,draw:false,startedAt:null,endsAt:null,timerPaused:false,remainingMs:0,expired:false};}
function freshDb(){
  const r1=initialMatches();
  return {version:1,state:'not_started',visits:0,matches:r1.concat([
    match('2-1',2,'المواجهة 1 في الدور الثاني'),match('2-3',2,'المواجهة 2 في الدور الثاني'),match('2-2',2,'المتأهل العشوائي'),
    match('3-1',3,'نصف النهائي'),match('4-1',4,'النهائي')
  ]),videos:{},recitations:{},comments:[],votes:{},sessions:{}};
}
function load(){
  if(!fs.existsSync(DB_FILE)){const d=freshDb();save(d);return d;}
  try {const d=JSON.parse(fs.readFileSync(DB_FILE,'utf8')); if(!d.matches)d.matches=freshDb().matches; if(!d.videos)d.videos={}; if(!d.recitations)d.recitations={}; if(!d.comments)d.comments=[]; if(!d.votes)d.votes={}; if(!d.sessions)d.sessions={}; return d;} catch {const d=freshDb();save(d);return d;}
}
let db=load();
let writeChain=Promise.resolve();
function save(d=db){
  writeChain=writeChain.then(async()=>{const tmp=DB_FILE+'.tmp';await fs.promises.writeFile(tmp,JSON.stringify(d,null,2),'utf8');await fs.promises.rename(tmp,DB_FILE);}).catch(console.error);
  return writeChain;
}
function publicDb(){
  const clone=JSON.parse(JSON.stringify(db)); delete clone.sessions;
  clone.matches=clone.matches.map(m=>sanitizeMatch(m));
  return {state:clone.state,visits:clone.visits,matches:clone.matches,allMatches:clone.matches,bracket:buildBracket(clone.matches),videos:clone.videos,recitations:clone.recitations,comments:clone.comments};
}
function sanitizeMatch(m){return {...m,votes:m.votes||{}};}
function findMatch(id){return db.matches.find(m=>m.id===id);}
function buildBracket(ms){const get=id=>ms.find(m=>m.id===id)||match(id,1,id);return {r1:ms.filter(m=>m.round===1),r2:ms.filter(m=>m.id==='2-1'||m.id==='2-3'),r2bye:get('2-2'),semi:get('3-1'),final:get('4-1')};}
function token(){return crypto.randomBytes(32).toString('hex');}
function auth(req,res,next){
  const h=req.get('authorization')||''; const t=h.startsWith('Bearer ')?h.slice(7):'';
  if(!t || !db.sessions[t]) return res.status(401).json({error:'غير مسجل الدخول.'});
  req.user=db.sessions[t].user; req.token=t; next();
}
function admin(req,res,next){if(!adminNames.has(req.user.name))return res.status(403).json({error:'ليس لديك صلاحية الإدارة.'});next();}
function validName(n){return typeof n==='string' && contestants.includes(n);}
function activeLeft(m){if(!m.startedAt)return 0;if(m.timerPaused)return Number(m.remainingMs||0);return Math.max(0,new Date(m.endsAt).getTime()-Date.now());}
function ensureExpired(m){if(m.startedAt && !m.timerPaused && !m.winner && !m.draw && activeLeft(m)<=0){m.expired=true;return true;}return false;}
function canUpload(m,user){return user.type==='admin' || (user.type==='contestant' && m.players.includes(user.name));}

const maxMb=Number(process.env.MAX_UPLOAD_MB||500);
const storage=multer.diskStorage({
  destination:(req,file,cb)=>cb(null,file.fieldname==='recitation'?REC_DIR:VIDEO_DIR),
  filename:(req,file,cb)=>{const ext=path.extname(file.originalname).toLowerCase().slice(0,12);cb(null,Date.now()+'-'+crypto.randomBytes(8).toString('hex')+ext);}
});
const upload=multer({storage,limits:{fileSize:maxMb*1024*1024}});
function safeOriginal(s){return String(s||'file').replace(/[\\/\0]/g,'_').slice(0,180);}
function fileInfo(file,kind){return {url:`/media/${kind}/${encodeURIComponent(file.filename)}`,downloadUrl:`/download/${kind}/${encodeURIComponent(file.filename)}`,originalName:safeOriginal(file.originalname),size:file.size,mime:file.mimetype};}

app.get('/health',(req,res)=>res.json({ok:true,service:'Jamal AlQuran'}));
app.post('/api/login',(req,res)=>{
  const {name,code,voter}=req.body||{};
  let user;
  if(name){
    if(!validName(name))return res.status(400).json({error:'اسم المتسابق غير صحيح.'});
    if(String(code||'')!==String(codeFor(name)||''))return res.status(401).json({error:'الكود غير صحيح.'});
    user={name,type:adminNames.has(name)?'admin':'contestant'};
  } else if(voter){
    const clean=String(voter).trim().replace(/\s+/g,' ');
    const parts=clean.split(' ');
    if(parts.length!==2)return res.status(400).json({error:'اكتب الاسم الثنائي: الاسم الأول واسم العائلة.'});
    if(contestants.includes(clean))return res.status(400).json({error:'الرجاء الدخول كمتسابق باستخدام الكود الخاص بك.'});
    user={name:clean,type:'voter'};
  } else return res.status(400).json({error:'بيانات الدخول ناقصة.'});
  const t=token();db.sessions[t]={user,createdAt:Date.now()};save();res.json({token:t,user});
});
app.get('/api/me',auth,(req,res)=>res.json({user:req.user}));
app.post('/api/visit',(req,res)=>{db.visits++;save();res.json({visits:db.visits});});
app.get('/api/public',auth,(req,res)=>{
  for(const m of db.matches) ensureExpired(m);
  res.json(publicDb());
});
app.get('/api/live',(req,res)=>{
  for(const m of db.matches) ensureExpired(m);
  const clone=publicDb();
  res.json({state:clone.state,visits:clone.visits,allMatches:clone.allMatches});
});

app.post('/api/upload-video',auth,upload.single('video'),async(req,res)=>{
  try{
    const m=findMatch(req.body.match), contestant=req.body.contestant;
    if(!m)return res.status(404).json({error:'المواجهة غير موجودة.'});
    if(!validName(contestant) || !m.players.includes(contestant))return res.status(400).json({error:'هذا المتسابق ليس في المواجهة.'});
    if(!canUpload(m,req.user))return res.status(403).json({error:'لا يمكنك رفع فيديو لهذه المواجهة.'});
    if(!req.file)return res.status(400).json({error:'لم يتم اختيار فيديو.'});
    db.videos[m.id] ||= {};
    const old=db.videos[m.id][contestant];
    if(old?.filename)try{fs.unlinkSync(path.join(VIDEO_DIR,old.filename));}catch{}
    db.videos[m.id][contestant]=fileInfo(req.file,'videos'); await save(); res.json({ok:true,video:db.videos[m.id][contestant]});
  }catch(e){if(req.file)try{fs.unlinkSync(req.file.path)}catch{};res.status(500).json({error:'فشل حفظ الفيديو.'});}
});
app.delete('/api/upload-video/:match/:name',auth,admin,async(req,res)=>{
  const m=findMatch(req.params.match), n=decodeURIComponent(req.params.name);const v=db.videos[m?.id]?.[n];if(!m||!v)return res.status(404).json({error:'الفيديو غير موجود.'});
  try{fs.unlinkSync(path.join(VIDEO_DIR,path.basename(v.url ? decodeURIComponent(v.url.split('/').pop()) : '')))}catch{}
  delete db.videos[m.id][n];await save();res.json({ok:true});
});

app.post('/api/admin/recitation',auth,admin,upload.single('recitation'),async(req,res)=>{
  const m=findMatch(req.body.match);if(!m)return res.status(404).json({error:'المواجهة غير موجودة.'});if(!req.file)return res.status(400).json({error:'لم يتم اختيار ملف.'});
  const old=db.recitations[m.id];if(old?.filename)try{fs.unlinkSync(path.join(REC_DIR,old.filename));}catch{}
  db.recitations[m.id]={...fileInfo(req.file,'recitations'),filename:req.file.filename};await save();res.json({ok:true,recitation:db.recitations[m.id]});
});
app.delete('/api/admin/recitation/:match',auth,admin,async(req,res)=>{const m=findMatch(req.params.match),r=db.recitations[m?.id];if(!m||!r)return res.status(404).json({error:'التلاوة غير موجودة.'});try{fs.unlinkSync(path.join(REC_DIR,r.filename));}catch{}delete db.recitations[m.id];await save();res.json({ok:true});});

app.post('/api/vote',auth,(req,res)=>{
  const {match:id,name}=req.body||{},m=findMatch(id);if(!m)return res.status(404).json({error:'المواجهة غير موجودة.'});
  ensureExpired(m);if(!m.startedAt||m.timerPaused||m.expired||m.winner||m.draw)return res.status(400).json({error:'التصويت مغلق حاليًا.'});
  if(!m.players.includes(name))return res.status(400).json({error:'اختيار التصويت غير صالح.'});
  if(req.user.type==='contestant'&&m.players.includes(req.user.name))return res.status(403).json({error:'لا يمكنك التصويت في مواجهتك.'});
  const key=`${req.user.name}::${m.id}`;const old=db.votes[key];m.votes ||= {};
  if(old===name)return res.json({ok:true,choice:name});
  if(old)m.votes[old]=Math.max(0,Number(m.votes[old]||0)-1);
  m.votes[name]=Number(m.votes[name]||0)+1;db.votes[key]=name;save();res.json({ok:true,choice:name});
});
app.post('/api/comments',auth,(req,res)=>{const {match,text}=req.body||{},m=findMatch(match);const t=String(text||'').trim();if(!m)return res.status(404).json({error:'المواجهة غير موجودة.'});if(!t)return res.status(400).json({error:'التعليق فارغ.'});if(t.length>500)return res.status(400).json({error:'التعليق طويل جدًا.'});const c={id:crypto.randomUUID(),match,name:req.user.name,text:t,createdAt:new Date().toISOString()};db.comments.push(c);save();res.json({ok:true,comment:c});});
app.delete('/api/comments/:id',auth,async(req,res)=>{const i=db.comments.findIndex(c=>c.id===req.params.id);if(i<0)return res.status(404).json({error:'التعليق غير موجود.'});const c=db.comments[i];if(c.name!==req.user.name&&!adminNames.has(req.user.name))return res.status(403).json({error:'لا يمكنك حذف هذا التعليق.'});db.comments.splice(i,1);await save();res.json({ok:true});});

function startMatch(m){if(!m.players[0]||!m.players[1]||m.players.includes('متأهل مباشرة'))throw Error('المواجهة غير مكتملة.');if(!db.videos?.[m.id]?.[m.players[0]]||!db.videos?.[m.id]?.[m.players[1]])throw Error('يجب رفع فيديو الطرفين أولًا.');m.startedAt=new Date().toISOString();m.endsAt=new Date(Date.now()+24*3600*1000).toISOString();m.timerPaused=false;m.remainingMs=24*3600*1000;m.expired=false;m.winner=null;m.draw=false;}
function advanceAfterEnd(m){
  if(m.round===1){const r1=db.matches.filter(x=>x.round===1);if(r1.every(x=>x.winner)){const winners=r1.map(x=>x.winner);if(!findMatch('2-2').winner){const chosen=winners[Math.floor(Math.random()*winners.length)];findMatch('2-2').players=[chosen,'متأهل مباشرة'];findMatch('2-2').winner=chosen;}const rest=winners.filter(x=>x!==findMatch('2-2').winner);const a=findMatch('2-1'),b=findMatch('2-3');a.players=[rest[0]||null,rest[1]||null];b.players=[rest[2]||null,rest[3]||null];}}
  if(m.round===2){const a=findMatch('2-1'),b=findMatch('2-3');if(a.winner&&b.winner){const s=findMatch('3-1');s.players=[a.winner,b.winner];} }
  if(m.round===3&&m.winner){const bye=findMatch('2-2');const f=findMatch('4-1');if(bye.winner)f.players=[m.winner,bye.winner];}
}
app.post('/api/admin/match/:action',auth,admin,async(req,res)=>{
  const m=findMatch(req.body?.match);if(!m)return res.status(404).json({error:'المواجهة غير موجودة.'});
  try{
    if(req.params.action==='start')startMatch(m);
    else if(req.params.action==='pause'){
      if(!m.startedAt||m.winner||m.draw)throw Error('الجولة ليست جارية.');
      if(m.timerPaused){m.endsAt=new Date(Date.now()+Number(m.remainingMs||0)).toISOString();m.timerPaused=false;m.expired=false;} else {m.remainingMs=activeLeft(m);m.timerPaused=true;}
    } else if(req.params.action==='end'){
      if(!m.startedAt)throw Error('الجولة لم تبدأ.');
      const p=m.players,v=m.votes||{},a=Number(v[p[0]]||0),b=Number(v[p[1]]||0);
      if(a===b){m.draw=true;m.winner=null;} else m.winner=a>b?p[0]:p[1];m.timerPaused=false;m.expired=true;advanceAfterEnd(m);
    } else throw Error('إجراء غير معروف.');
    await save();res.json({ok:true});
  }catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/admin/state',auth,admin,async(req,res)=>{const s=req.body?.state;if(!['started','not_started'].includes(s))return res.status(400).json({error:'حالة غير صحيحة.'});db.state=s;await save();res.json({ok:true,state:s});});
app.post('/api/admin/reset',auth,admin,async(req,res)=>{
  for(const d of [VIDEO_DIR,REC_DIR])for(const f of fs.readdirSync(d))try{fs.unlinkSync(path.join(d,f));}catch{}
  db=freshDb();await save(db);res.json({ok:true});
});

function sendFile(dir,req,res){const name=path.basename(decodeURIComponent(req.params.name));const file=path.join(dir,name);if(!fs.existsSync(file))return res.status(404).end();res.sendFile(file);}
app.get('/media/videos/:name',(req,res)=>sendFile(VIDEO_DIR,req,res));
app.get('/media/recitations/:name',(req,res)=>sendFile(REC_DIR,req,res));
app.get('/download/videos/:name',(req,res)=>{const name=path.basename(decodeURIComponent(req.params.name));const v=Object.values(db.videos).flatMap(x=>Object.values(x)).find(v=>v.url?.endsWith(encodeURIComponent(name)));const file=path.join(VIDEO_DIR,name);if(!fs.existsSync(file))return res.status(404).end();res.download(file,v?.originalName||name);});
app.get('/download/recitations/:name',(req,res)=>{const name=path.basename(decodeURIComponent(req.params.name));const r=Object.values(db.recitations).find(r=>r.url?.endsWith(encodeURIComponent(name)));const file=path.join(REC_DIR,name);if(!fs.existsSync(file))return res.status(404).end();res.download(file,r?.originalName||name);});

app.use(express.static(path.join(ROOT,'public'),{extensions:['html']}));
app.use((err,req,res,next)=>{if(err instanceof multer.MulterError)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?`حجم الملف أكبر من ${maxMb}MB.`:'فشل رفع الملف.'});console.error(err);res.status(500).json({error:'حدث خطأ غير متوقع.'});});
const PORT=Number(process.env.PORT||3000);app.listen(PORT,()=>console.log(`Jamal AlQuran running on port ${PORT}`));
