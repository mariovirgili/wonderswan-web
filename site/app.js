// SPDX-License-Identifier: GPL-2.0-or-later
/* Independent HTML5 frontend for three WonderSwan emulator cores compiled to
 * WebAssembly: Beetle WonderSwan (Mednafen) and Mesen 2 through a small
 * libretro host, and ares. All export the same small ws_* C API, so the page
 * can switch between them, keeping the running game. All game content stays
 * in this browser. No RetroArch runtime. */
'use strict';
const $=id=>document.getElementById(id);
const canvas=$('screen'),ctx=canvas.getContext('2d',{alpha:false});
ctx.imageSmoothingEnabled=false;
const overlay=$('overlay'), status=$('status');
let core=null, running=false, paused=false, romName='', romKey='', romLoaded=false;
/* What the running core last reported: picture size, frame rate, sample rate, battery-save size. */
let info={width:224,height:144,fps:75.47,rate:44100,saveSize:0};
let inFlight=false, lastVideo=null, msPerFrame=0, framesRun=0;
/* The emulator cores. Each runs in its own Web Worker (worker.js), started the first time it is
 * chosen and kept; the page sends it requests and draws what comes back. */
const CORES={beetle:{label:'Mednafen',script:'./core.js',factory:'createWonderSwan'},ares:{label:'ares',script:'./core-ares.js',factory:'createAres'},mesen:{label:'Mesen',script:'./core-mesen.js',factory:'createMesen'}};
/* Mesen also runs some other systems that need no BIOS, picked by the ROM's extension (passed to its
 * bridge as the content file's extension). Not advertised on the page. */
const OTHER_SYSTEMS={nes:'nes',sfc:'sfc',smc:'sfc',gb:'gb',gbc:'gbc',sms:'sms',gg:'gg',pce:'pce'};
const systemOf=name=>OTHER_SYSTEMS[(/\.([^.]+)$/.exec(name||'')||[])[1]?.toLowerCase()]||'ws';
let switchedFrom='';// the core chosen before a ROM of another system moved the page to Mesen
const instances={};let coreName='',coreBusy=false,current=null;// current: the running game {bytes,name,note}
let original=null;// the ROM as loaded, before any patch {bytes,name}: a local patch file is applied to it
let fastForward=false,ffKey=false,ffTouch=false,slot=1;
let frameDuration=1000/75.47, lastFrame=0, bank=0, buttons=0, gamepadBits=0;
let audioContext=null, nextAudioTime=0, volume=.6, lastAutosave=0;
let audioGain=null, audioNode=null, soundOn=false, workletRate=0;
/* Controls. Each action is a WonderSwan input bit (the libretro joypad id used by the cores) or 'ff'
 * (fast forward). The keyboard keys (KeyboardEvent.code) and gamepad buttons (standard mapping) of
 * each action can be changed and are kept in this browser; the left stick always moves the X pad. */
const ACTIONS=[[4,'X pad ↑'],[7,'X pad →'],[5,'X pad ↓'],[6,'X pad ←'],[13,'Y pad ↑'],[11,'Y pad →'],[12,'Y pad ↓'],[10,'Y pad ←'],
 [8,'A'],[0,'B'],[3,'Start'],[2,'Rotate'],['ff','Fast forward (hold)']];
const DEFAULT_KEYS={4:['ArrowUp'],7:['ArrowRight'],5:['ArrowDown'],6:['ArrowLeft'],13:['KeyW'],11:['KeyD'],12:['KeyS'],10:['KeyA'],8:['KeyX'],0:['KeyZ'],3:['Enter'],2:['ShiftLeft','ShiftRight'],ff:['Space']};
const DEFAULT_PAD={4:[12],7:[15],5:[13],6:[14],13:[6],11:[5],12:[7],10:[4],8:[0],0:[1],3:[9],2:[8],ff:[10,11]};
const RESERVED_KEYS=new Set(['F5','F7','Digit1','Digit2','Digit3','Escape','Tab']);
function loadMap(key,def){try{const m=JSON.parse(pref(key,'null'));if(m&&typeof m==='object')return {...def,...m};}catch{}return {...def};}
let keyBinds=loadMap('keys',DEFAULT_KEYS),padBinds=loadMap('pad',DEFAULT_PAD),keyMap={};
function buildKeyMap(){keyMap={};for(const [a] of ACTIONS)for(const code of keyBinds[a]||[])keyMap[code]=a;}
function message(t){status.textContent=t}
/* Input latch: a press is held for at least LATCH_FRAMES emulated frames,
 * so taps shorter than a frame (or than the game's polling interval) are not lost. */
const LATCH_FRAMES=6, latch=new Uint8Array(32);
function press(b){buttons|=1<<b;latch[b]=LATCH_FRAMES;}
function release(b){buttons&=~(1<<b);}
function inputMask(){let m=buttons|gamepadBits;for(let i=0;i<32;i++)if(latch[i])m|=1<<i;
 // Other systems: Y pad ↑ / ↓ (W / S) are the X and Y buttons; ← / → (A / D) stay L and R.
 if(info.system&&info.system!=='ws')m=(m&~(1<<13|1<<12))|(m>>13&1)<<9|(m>>12&1)<<1;
 else if(canvas.height>canvas.width)m=verticalMask(m);
 return m>>>0;}
/* Vertical games: the WonderSwan is held upright, the Y pad is the direction pad and the X pad the
 * action buttons. While the picture is vertical the page's two pads swap, each turned to match the
 * screen: the arrows (X pad keys, left stick, touch X pad) move with the Y pad, and the Y pad keys
 * (W A S D, touch Y pad) press the X pad buttons. Same turn as Beetle's own rotated key map. */
const VERTICAL_FROM=[[4,11],[7,12],[5,10],[6,13],[13,7],[11,5],[12,6],[10,4]];// [page bit, WonderSwan bit]
function verticalMask(m){let out=m&~(0xF0|0x3C00);for(const [from,to] of VERTICAL_FROM)if(m>>from&1)out|=1<<to;return out;}
function tickLatch(){for(let i=0;i<32;i++)if(latch[i])latch[i]--;}
function clearInput(){buttons=0;latch.fill(0);}
function enabled(v){for(const id of ['pause','reset','sound','export-save','export-state','qsave','qload','patch-file','ff'])$(id).disabled=!v;$('patch-file-label').classList.toggle('disabled',!v);}
function drawWelcome(){ctx.fillStyle='#10192d';ctx.fillRect(0,0,224,144);ctx.strokeStyle='#2a4474';for(let i=0;i<224;i+=16){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,144);ctx.stroke()}for(let i=0;i<144;i+=16){ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(224,i);ctx.stroke()}}
drawWelcome();
/* A core in its worker: call(cmd, args) resolves with the worker's answer, in order. */
class CoreProxy{
 constructor(){this.seq=0;this.pending=new Map();this.worker=new Worker('./worker.js');
  this.worker.onmessage=e=>{const d=e.data;if(d.log){(console[d.log.level]||console.log)(d.log.text);return;}
   const p=this.pending.get(d.id);if(!p)return;this.pending.delete(d.id);d.ok?p.resolve(d.result):p.reject(Error(d.error));};
  this.worker.onerror=e=>{e.preventDefault?.();const err=Error(e.message||'worker error');for(const p of this.pending.values())p.reject(err);this.pending.clear();};}
 call(cmd,args,transfer=[]){const id=++this.seq;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.worker.postMessage({id,cmd,args},transfer);});}
}
async function coreInstance(name){if(instances[name])return instances[name];const c=CORES[name],proxy=new CoreProxy();
 try{await proxy.call('init',{script:c.script,factory:c.factory});}catch(e){proxy.worker.terminate();throw e;}
 return instances[name]=proxy;}
const setOption=(key,value)=>core?.call('setOption',{key,value}).catch(e=>console.warn('option',key,e));
/* What sets each core apart, shown next to the picker. The console runs at 75.47 Hz; most screens
 * refresh at 60 Hz, so a core at native speed has about 1 frame in 5 that is never displayed. */
const CORE_INFO={
 mesen:{title:'Mesen 2',points:['Default. High accuracy, and the lightest on the CPU here (about 1.5–2.5 ms per frame), but the largest download (5.3 MB).','Screen: by default the picture as the console outputs it – plain colours, no frame blending (both can be turned on under Options → Screen).','Refresh: native 75.47 Hz. On a 60 Hz screen about 1 frame in 5 is not shown, so fast motion can look slightly uneven. Vertical games turn by themselves.']},
 beetle:{title:'Beetle (Mednafen)',points:['The long-standing libretro core: smallest download (0.2 MB), light on the CPU, less accurate than the other two.','Screen: plain picture, no frame blending.','Refresh: the only core with the 60 Hz mode (Options) – it shows 4 of every 5 frames at an even 60.38 Hz, for smooth motion on 60 Hz screens; off, native 75.47 Hz. Vertical games are turned with Rotate.']},
 ares:{title:'ares',points:['High accuracy: every chip runs in step with the others. The heaviest on the CPU (about 5–8 ms per frame; 0.8 MB download).','Screen: imitates the real LCD by default. Colours follow its duller, washed-out response, and each frame is blended with the previous one as the slow LCD did: flickering sprites and effects turn into steady half-tones, and fast motion leaves a slight trail (both can be turned off under Options → Screen).','Refresh: native 75.47 Hz (no 60 Hz mode); on a 60 Hz screen the blending softens the skipped frames. Vertical games turn by themselves.']},
};
function showCoreInfo(name){const box=$('core-info'),info=CORE_INFO[name];box.replaceChildren();if(!info)return;const t=document.createElement('strong');t.textContent=info.title;const ul=document.createElement('ul');for(const p of info.points){const li=document.createElement('li');li.textContent=p;ul.append(li);}box.append(t,ul);}
function showCore(name){showCoreInfo(name);for(const r of document.querySelectorAll('input[name=core]'))r.checked=r.value===name;const other=!!name&&name!=='beetle';$('opt-60hz').disabled=other;$('opt-60hz-note').hidden=!other;}
/* Switch emulator core. A running game moves to the new core with its battery save. */
async function useCore(name){if(!CORES[name]||name===coreName||coreBusy){showCore(coreName);return;}coreBusy=true;const wasPaused=paused;paused=true;
 try{message(`Loading ${CORES[name].label} WASM…`);const next=await coreInstance(name);
  if(romLoaded){await persistRam();await core.call('unload');romLoaded=false;enabled(false);}
  core=next;coreName=name;showCore(name);applyOptions();
  if(current){try{await startRom(current.bytes,current.name,current.note);paused=wasPaused;$('pause').textContent=paused?'Resume':'Pause';}
   catch(e){console.warn(e);current=null;overlay.hidden=false;message(`${CORES[name].label} core ready. It could not run the previous game (${e.message}); choose a ROM.`);}}
  else message(`${CORES[name].label} core ready. Choose a .ws, .wsc or .pc2 ROM, or a .zip / .7z containing one.`);}
 catch(e){console.error(e);message(`${CORES[name].label} core unavailable: ${e.message}`);showCore(coreName);if(!core)overlay.textContent='BUILD THE WASM CORE FIRST';paused=wasPaused;}
 finally{coreBusy=false;}}
/* Mesen is the default (the fastest in the browser). Only a choice made in the picker is remembered
 * ('swanweb.emulator'; the older 'swanweb.core' also stored the default and is ignored). */
const DEFAULT_CORE='mesen';
function startup(){const q=new URLSearchParams(location.search).get('core'),saved=pref('emulator','');const name=CORES[q]?q:(CORES[saved]?saved:DEFAULT_CORE);showCore(name);useCore(name);}
function render(video,w,h){if(!w||!h||w>1024||h>1024||!video||video.length!==w*h*4)return;lastVideo=video;if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;canvas.classList.toggle('portrait',h>w);ctx.imageSmoothingEnabled=false;fitCanvas();}ctx.putImageData(new ImageData(new Uint8ClampedArray(video.buffer,video.byteOffset,video.length),w,h),0,0);}
/* Audio: the core's samples go to an AudioWorklet ring buffer that plays them
 * on the audio clock. The worklet keeps ~60 ms queued and nudges its playback
 * rate by at most ±0.5% to follow the emulator, so there are no per-frame
 * buffer seams (clicks) and no drift. Older browsers fall back to scheduled
 * AudioBufferSources. */
const WORKLET=`class SwanOut extends AudioWorkletProcessor{
constructor(o){super();const p=o.processorOptions;this.cap=p.capacity;this.buf=new Float32Array(this.cap*2);
this.r=0;this.w=0;this.n=0;this.frac=0;this.primed=false;this.cfg(p);
this.port.onmessage=e=>{const d=e.data;if(d==='reset'){this.r=this.w=this.n=0;this.frac=0;this.primed=false}else if(d.ratio)this.cfg(d);else this.push(d)}}
cfg(p){this.ratio=p.ratio;this.target=p.target;this.max=p.max}
push(d){const f=d.length>>1,c=this.cap,b=this.buf;for(let i=0;i<f;i++){if(this.n>=c){this.r=(this.r+1)%c;this.n--}
const j=this.w*2;b[j]=d[i*2];b[j+1]=d[i*2+1];this.w=(this.w+1)%c;this.n++}
if(this.n>this.max){const drop=this.n-this.target;this.r=(this.r+drop)%c;this.n-=drop}}
process(_,outs){const o=outs[0],L=o[0],R=o[1]||o[0],len=L.length,c=this.cap,b=this.buf;
if(!this.primed){if(this.n<this.target){L.fill(0);R.fill(0);return true}this.primed=true}
const adj=Math.max(-.005,Math.min(.005,(this.n-this.target)/this.target*.005)),step=this.ratio*(1+adj);
for(let i=0;i<len;i++){if(this.n<2){L[i]=R[i]=0;this.primed=false;continue}
const a=this.r*2,z=((this.r+1)%c)*2,f=this.frac;L[i]=b[a]+(b[z]-b[a])*f;R[i]=b[a+1]+(b[z+1]-b[a+1])*f;
this.frac+=step;const adv=this.frac|0;this.frac-=adv;this.r=(this.r+adv)%c;this.n-=adv}
return true}}
registerProcessor('swan-out',SwanOut);`;
function audioConfig(rate){return{ratio:rate/audioContext.sampleRate,target:Math.round(rate*.06),max:Math.round(rate*.15)};}
async function startAudio(){const rate=info.rate>8000?info.rate:44100;
 if(!audioContext){const AC=window.AudioContext||window.webkitAudioContext;
  try{audioContext=new AC({sampleRate:rate,latencyHint:'interactive'})}catch{audioContext=new AC({latencyHint:'interactive'})}
  audioGain=audioContext.createGain();audioGain.gain.value=volume;audioGain.connect(audioContext.destination);
  if(audioContext.audioWorklet&&window.AudioWorkletNode){const url=URL.createObjectURL(new Blob([WORKLET],{type:'text/javascript'}));
   try{await audioContext.audioWorklet.addModule(url);workletRate=rate;
    audioNode=new AudioWorkletNode(audioContext,'swan-out',{numberOfInputs:0,outputChannelCount:[2],processorOptions:{capacity:Math.ceil(rate*.5),...audioConfig(rate)}});
    audioNode.connect(audioGain);}catch(e){console.warn('AudioWorklet unavailable, using buffer fallback',e);audioNode=null;}finally{URL.revokeObjectURL(url);}}}
 await audioContext.resume();}
function setSoundButton(){const b=$('sound');b.textContent=soundOn?'Disable sound':'Enable sound';b.setAttribute('aria-pressed',String(soundOn));b.classList.toggle('active',soundOn);}
async function toggleSound(){if(soundOn){soundOn=false;audioNode?.port.postMessage('reset');try{await audioContext?.suspend()}catch{}setSoundButton();message('Audio disabled');return;}
 try{await startAudio();audioNode?.port.postMessage('reset');nextAudioTime=0;soundOn=true;setSoundButton();message(audioNode?'Audio enabled':'Audio enabled (compatibility mode)');}catch(e){message('Audio unavailable: '+e.message);}}
function feedAudio(input,rate){if(!soundOn||!audioContext||audioContext.state!=='running'||!input?.length)return;const n=input.length>>1;if(!(rate>8000))return;
 if(audioNode){if(rate!==workletRate){workletRate=rate;audioNode.port.postMessage(audioConfig(rate));}
  const f=new Float32Array(n*2);for(let i=0;i<n*2;i++)f[i]=input[i]/32768;audioNode.port.postMessage(f,[f.buffer]);return;}
 const output=audioContext.createBuffer(2,n,rate),left=output.getChannelData(0),right=output.getChannelData(1);for(let i=0;i<n;i++){left[i]=input[i*2]/32768;right[i]=input[i*2+1]/32768;}
 const src=audioContext.createBufferSource();src.buffer=output;src.connect(audioGain);const now=audioContext.currentTime;if(nextAudioTime<now||nextAudioTime-now>.20)nextAudioTime=now+.035;src.start(nextAudioTime);nextAudioTime+=n/rate;src.onended=()=>src.disconnect();}
let gamepadFF=false;
function pollPad(){gamepadBits=0;gamepadFF=false;for(const p of navigator.getGamepads?.()||[]){if(!p||!p.connected)continue;const pressed=i=>!!p.buttons[i]?.pressed,axis=i=>p.axes[i]||0;
 for(const [a] of ACTIONS)if((padBinds[a]||[]).some(pressed)){if(a==='ff')gamepadFF=true;else gamepadBits|=1<<a;}
 if(info.system&&info.system!=='ws'){if(pressed(2))gamepadBits|=1<<12;if(pressed(3))gamepadBits|=1<<13;}
 if(axis(1)<-.5)gamepadBits|=1<<4;if(axis(1)>.5)gamepadBits|=1<<5;if(axis(0)<-.5)gamepadBits|=1<<6;if(axis(0)>.5)gamepadBits|=1<<7;break;}}
/* Fast forward (hold Space or the ⏩ button): up to FF_SPEED× speed, as far as the CPU allows; the
 * sound is skipped meanwhile. */
const FF_SPEED=4;
/* Each display refresh asks the worker for the frames that are due (one input mask per frame), unless
 * the previous batch is still running; the answer brings the last picture and the batch's sound. */
/* FPS counter (button FPS, remembered): frames the core ran in the last half second, per second,
 * and the speed against the console's own rate (100% = real time; more in fast forward). */
let fpsFrames=0,fpsSince=0;
function countFps(n){fpsFrames+=n;const now=performance.now();if(!fpsSince){fpsSince=now;return;}const dt=now-fpsSince;if(dt<500)return;
 const fps=fpsFrames*1000/dt,box=$('fps-counter');fpsFrames=0;fpsSince=now;
 if(!box.hidden)box.textContent=`${fps.toFixed(1)} fps · ${Math.round(fps/(info.fps||75.47)*100)}%`;}
function showFps(on){$('fps-counter').hidden=!on;$('fps-counter').textContent='— fps';$('fps-toggle').setAttribute('aria-pressed',String(on));fpsFrames=0;fpsSince=0;}
function loop(now){requestAnimationFrame(loop);if(!romLoaded||paused||!core){lastFrame=now;return;}if(inFlight)return;
 frameDuration=1000/(info.fps||75.47);const dt=Math.min(now-lastFrame,100);lastFrame=now;
 pollPad();const ff=fastForward=ffKey||ffTouch||gamepadFF;bank+=ff?dt*FF_SPEED:dt;
 let n=Math.min(Math.floor(bank/frameDuration),ff?FF_SPEED*4:4);
 if(ff&&msPerFrame>0)n=Math.min(n,Math.max(2,Math.floor(30/msPerFrame)));// as fast as this CPU allows: the worker
 // may take longer than one display refresh without stopping the page
 if(now-lastAutosave>10000){lastAutosave=now;persistRam().catch(console.warn);}
 if(n<1)return;bank-=n*frameDuration;if(ff)bank=Math.min(bank,frameDuration);
 const masks=[];for(let i=0;i<n;i++){masks.push(inputMask());tickLatch();}
 inFlight=true;const runner=core;
 runner.call('run',{masks,wantAudio:soundOn&&!ff}).then(r=>{if(runner!==core||!romLoaded)return;msPerFrame=r.ms/n;countFps(r.frames);framesRun+=r.frames;
   info.width=r.width;info.height=r.height;info.fps=r.fps||info.fps;info.rate=r.rate||info.rate;
   render(r.video,r.width,r.height);feedAudio(r.pcm,r.rate);$('fps').textContent=`${r.width}×${r.height} · ${info.fps.toFixed(2)} Hz${ff?' · ⏩ fast forward':''}`;})
  .catch(e=>console.error(e)).finally(()=>{inFlight=false;});}
async function digest(bytes){const hash=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash)).map(x=>x.toString(16).padStart(2,'0')).join('');}
/* IndexedDB: 'sram' (battery saves, by ROM SHA-256) and, since version 2, 'states' (quick-save slots,
 * by ROM SHA-256 + core + slot: a state only fits the core that made it). */
function openDB(){return new Promise((resolve,reject)=>{if(!indexedDB){resolve(null);return;}const req=indexedDB.open('swanweb-save-v1',2);req.onupgradeneeded=()=>{const db=req.result;for(const s of ['sram','states'])if(!db.objectStoreNames.contains(s))db.createObjectStore(s);};req.onerror=()=>reject(req.error);req.onsuccess=()=>resolve(req.result);});}
async function store(key,bytes,os='sram'){if(!key||!(bytes?.length||bytes?.state))return;const db=await openDB();if(!db)return;await new Promise((resolve,reject)=>{const tx=db.transaction(os,'readwrite');tx.objectStore(os).put(bytes,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();}
async function retrieve(key,os='sram'){const db=await openDB();if(!db)return null;const data=await new Promise((resolve,reject)=>{const tx=db.transaction(os);const req=tx.objectStore(os).get(key);req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error)});db.close();return data;}
/* Battery saves between emulators. All three cores give the cartridge's SRAM or EEPROM as it is (the
 * EEPROM as 16-bit words, low byte first, in all of them), but for header code 01 (a 64 Kbit SRAM) Mednafen
 * keeps 8 KB, the real chip, and ares and Mesen 32 KB. Saves are stored and exported at the real chip's
 * size and fitted to the running core's size on load: a smaller save is repeated (the chip is mirrored
 * across the larger space), a larger one cut. A save that does not fit is never overwritten. */
const CHIP_SIZES={1:8192,2:32768,3:131072,4:262144,5:524288,0x10:128,0x20:2048,0x50:1024};
const chipSize=rom=>rom?.length>=16?CHIP_SIZES[rom[rom.length-5]]||0:0;
function fitSave(bytes,size){if(!bytes?.length||!size)return null;if(bytes.length===size)return bytes;
 if(size%bytes.length===0){const out=new Uint8Array(size);for(let o=0;o<size;o+=bytes.length)out.set(bytes,o);return out;}
 if(bytes.length%size===0)return bytes.slice(0,size);return null;}
let saveKey='';// where this game's battery save is kept: romKey, or romKey|size when the stored one did not fit
async function persistRam(){if(!romLoaded||!saveKey||!info.saveSize)return;const bytes=await core.call('getSave');
 if(bytes?.length)await store(saveKey,saveKey===romKey?fitSave(bytes,info.chipSize)||bytes:bytes);}
/* An archive with several ROMs: let the player choose one. Resolves to {name, bytes} or null. */
function pickRom(archiveName,roms){const dlg=$('rom-dialog'),list=$('rom-list');$('rom-archive').textContent=archiveName;list.replaceChildren();
 roms.forEach((r,k)=>{const l=document.createElement('label');l.className='patch-item';const i=document.createElement('input');i.type='radio';i.name='rom';i.value=String(k);i.checked=k===0;
  const t=document.createElement('span');t.className='patch-text';const s=document.createElement('strong');s.textContent=r.name.split('/').pop();const v=document.createElement('span');v.className='patch-variant';v.textContent=`${r.name} · ${(r.bytes.length/1024).toLocaleString()} KB`;t.append(s,v);l.append(i,t);list.append(l);});
 return new Promise(res=>{dlg.addEventListener('close',()=>{const c=list.querySelector('input[name=rom]:checked');res(dlg.returnValue==='ok'&&c?roms[+c.value]:null);},{once:true});dlg.returnValue='';dlg.showModal();$('rom-ok').focus();});}
/* A notice under the status line: this ROM was made with an older version of a translation. */
function showNotice(n){const box=$('notice');box.replaceChildren();box.hidden=!n;if(!n)return;
 box.append(`This ROM was made with ${n.made.variant} v${n.made.version}. ${n.newer.game||'The translation'} v${n.newer.version} is out: load the original ROM to apply it.`);
 if(/^https:\/\//.test(n.newer.page||'')){const a=document.createElement('a');a.href=n.newer.page;a.target='_blank';a.rel='noopener noreferrer';a.textContent='Release page';box.append(' ',a);}}
async function loadRom(file){if(!file||!core||coreBusy)return;showNotice(null);if(!/\.(ws|wsc|pc2|zip|7z)$/i.test(file.name)&&systemOf(file.name)==='ws'){message('Unsupported file type: choose a .ws, .wsc, .pc2, .zip or .7z file');return;}
 const wasPaused=paused;try{paused=true;clearInput();let bytes=new Uint8Array(await file.arrayBuffer());let name=file.name,patchNote='';
  if(SwanArchive.isArchive(name)){message(`Opening ${name}…`);const roms=await SwanArchive.extractRoms(name,bytes);if(!roms.length)throw Error(`no .ws/.wsc/.pc2 ROM inside ${name}`);
   const r=roms.length===1?roms[0]:await pickRom(name,roms);if(!r){paused=wasPaused;message('Cancelled');return;}bytes=r.bytes;name=r.name.split('/').pop();}
  original={bytes,name};
  const system=systemOf(name);
  if(system!=='ws'&&coreName!=='mesen'){switchedFrom=coreName;current=null;await useCore('mesen');if(coreName!=='mesen')throw Error('Mesen is not available');}
  else if(system==='ws'&&switchedFrom&&coreName==='mesen'){const back=switchedFrom;switchedFrom='';current=null;await useCore(back);}
  if(system==='ws'&&pref('patches','1')==='1'&&typeof SwanPatches!=='undefined'){try{const r=await SwanPatches.offer(bytes,name,message);bytes=r.bytes;name=r.name;
    if(r.patch)patchNote=` · patched with ${r.patch.variant}${r.patch.version?' v'+r.patch.version:''}`;
    else if(r.recognised)patchNote=` · recognised: ${r.recognised.game||''} ${r.recognised.variant}${r.recognised.version?' v'+r.recognised.version:''}`;
    showNotice(r.newer?{made:r.recognised,newer:r.newer}:null);}
   catch(e){console.error(e);patchNote=` · PATCH FAILED (${e.message}), running the original ROM`;}}
  await startRom(bytes,name,patchNote);}
 catch(e){console.error(e);paused=wasPaused;message('Could not load ROM: '+e.message);}}
/* Run a ROM (already patched) on the current core and restore its battery save. */
async function startRom(bytes,name,note){await persistRam();if(romLoaded)await core.call('unload');romLoaded=false;saveKey='';enabled(false);clearInput();
 romKey=await digest(bytes);romName=name;current={bytes,name,note};const system=systemOf(name);
 // A .wsc file runs on the WonderSwan Color even when its header does not say so (Mesen's rule; some
 // Color-only games, e.g. Judgement Silversword, leave the flag unset). Beetle always emulates the Color.
 await core.call('setOption',{key:'bridge_content_ext',value:system!=='ws'?system:/\.wsc$/i.test(name)?'wsc':''});const r=await core.call('load',{rom:bytes});if(!r.ok)throw Error('Core rejected the ROM');
 info={width:r.width,height:r.height,fps:r.fps,rate:r.rate,saveSize:r.saveSize,system};lastVideo=null;msPerFrame=0;romLoaded=true;
 info.chipSize=system==='ws'?chipSize(bytes):0;saveKey=romKey;let saved=await retrieve(romKey),restored='';
 if(saved&&info.saveSize){const fit=fitSave(saved,info.saveSize);
  if(!fit){saveKey=`${romKey}|${info.saveSize}`;saved=await retrieve(saveKey);// kept apart: the other save stays as it is
   if(saved?.length===info.saveSize&&await core.call('setSave',{bytes:saved}))restored=' · battery save restored';
   else restored=` · the battery save (${kb(saved?.length||0)}) does not fit this emulator (${kb(info.saveSize)}) and is kept as it is`;}
  else if(await core.call('setSave',{bytes:fit}))restored=fit.length===saved.length?' · battery save restored':` · battery save restored (${kb(saved.length)} → ${kb(fit.length)})`;}
 message(`Loaded ${romName}${note}${restored}`);
 enabled(true);paused=false;$('pause').textContent='Pause';bank=0;nextAudioTime=0;audioNode?.port.postMessage('reset');overlay.hidden=true;refreshSlots();}
function download(bytes,name){if(!bytes?.length){message('No data available to export');return;}const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function kb(n){return n>=1024?`${n/1024} KB`:`${n} bytes`;}
function stem(){return romName.replace(/\.[^.]+$/,'')||'wonderswan';}
$('rom').addEventListener('change',e=>{loadRom(e.target.files[0]);e.target.value='';});
/* A ROM (or archive) dropped anywhere on the page is loaded too. */
window.addEventListener('dragover',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';}});
window.addEventListener('drop',e=>{const f=e.dataTransfer?.files?.[0];if(!f)return;e.preventDefault();if(!document.querySelector('dialog[open]'))loadRom(f);});
$('pause').onclick=()=>{paused=!paused;bank=0;$('pause').textContent=paused?'Resume':'Pause';message(paused?'Paused':'Running');};
$('reset').onclick=async()=>{await core.call('reset');message('Console reset');};
/* Fullscreen: the screen area fills the display (where the browser has no element fullscreen, as on the
 * iPhone, it fills the page instead). With Touch on, the touch controls move over the picture. */
const screenWrap=document.querySelector('.screen-wrap'),touchPad=document.querySelector('.touch-controls');
const touchHome={parent:touchPad.parentNode,next:touchPad.nextSibling};
touchPad.addEventListener('contextmenu',e=>e.preventDefault());// a long press is a held button, not a menu
const isFull=()=>!!document.fullscreenElement||screenWrap.classList.contains('pseudo-full');
function placeTouch(){const on=isFull()&&pref('fstouch','0')==='1';touchPad.classList.toggle('on-screen',on);
 if(on&&touchPad.parentNode!==screenWrap)screenWrap.append(touchPad);else if(!on&&touchPad.parentNode===screenWrap)touchHome.parent.insertBefore(touchPad,touchHome.next);
 $('fs-exit').hidden=!isFull();$('fs-touch').setAttribute('aria-pressed',String(pref('fstouch','0')==='1'));fitCanvas();}
function leaveFull(){if(document.fullscreenElement)document.exitFullscreen?.();screenWrap.classList.remove('pseudo-full');document.body.style.overflow='';placeTouch();}
async function enterFull(){try{if(!screenWrap.requestFullscreen)throw Error('no fullscreen');await screenWrap.requestFullscreen({navigationUI:'hide'});}
 catch{screenWrap.classList.add('pseudo-full');document.body.style.overflow='hidden';}placeTouch();}
$('fullscreen').onclick=e=>{e.currentTarget.blur();isFull()?leaveFull():enterFull();};
$('fs-exit').onclick=leaveFull;
$('fs-touch').onclick=e=>{savePref('fstouch',pref('fstouch','0')==='1'?'0':'1');e.currentTarget.blur();placeTouch();};
document.addEventListener('fullscreenchange',placeTouch);
window.addEventListener('keydown',e=>{if(e.code==='Escape'&&screenWrap.classList.contains('pseudo-full')&&!document.querySelector('dialog[open]'))leaveFull();});
$('fs-touch').setAttribute('aria-pressed',String(pref('fstouch','0')==='1'));
$('sound').onclick=toggleSound;$('volume').oninput=e=>{volume=Number(e.target.value)/100;if(audioGain)audioGain.gain.value=volume;};
$('export-save').onclick=async()=>{const b=await core.call('getSave');download(fitSave(b,info.chipSize)||b,stem()+'.sav');};// at the real chip's size
$('import-save').onchange=async e=>{const f=e.target.files[0];if(f&&romLoaded){const b=new Uint8Array(await f.arrayBuffer()),fit=fitSave(b,info.saveSize);if(fit&&await core.call('setSave',{bytes:fit})){message(fit.length===b.length?'SRAM imported':`SRAM imported (${kb(b.length)} → ${kb(fit.length)})`);await persistRam();}else message(`SRAM size mismatch: ${kb(b.length)}, expected ${kb(info.saveSize)}${info.chipSize&&info.chipSize!==info.saveSize?` or ${kb(info.chipSize)}`:''}`);}e.target.value='';};
$('export-state').onclick=async()=>{const s=await core.call('saveState');if(s?.length)download(s,stem()+'.state');else message('State save failed');};
$('import-state').onchange=async e=>{const f=e.target.files[0];if(f&&romLoaded){const b=new Uint8Array(await f.arrayBuffer());try{const ok=await core.call('loadState',{bytes:b});message(ok?'State restored':'State rejected (different ROM/core?)');}catch(err){message(err.message)}}e.target.value='';};
window.addEventListener('keydown',e=>{if(/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)||document.querySelector('dialog[open]'))return;
 if(romLoaded){if(keyMap[e.code]==='ff'){e.preventDefault();ffKey=true;return;}
  if(e.code==='F5'||e.code==='F7'){e.preventDefault();if(!e.repeat)(e.code==='F5'?quickSave:quickLoad)();return;}
  const d=/^Digit([1-3])$/.exec(e.code);if(d&&!e.ctrlKey&&!e.altKey&&!e.metaKey){selectSlot(+d[1]);return;}}
 const b=keyMap[e.code];if(b!==undefined){if(romLoaded)e.preventDefault();if(!e.repeat)press(b);}});
window.addEventListener('keyup',e=>{const b=keyMap[e.code];if(b==='ff')ffKey=false;else if(b!==undefined)release(b);});
/* The Controls help and the remapping dialog. */
const keyName=c=>({ArrowUp:'↑',ArrowDown:'↓',ArrowLeft:'←',ArrowRight:'→',ShiftLeft:'Shift',ShiftRight:'Right Shift',ControlLeft:'Ctrl',ControlRight:'Right Ctrl',AltLeft:'Alt',AltRight:'AltGr',Space:'Space',Enter:'Enter',Backspace:'Backspace'})[c]||c.replace(/^Key|^Digit|^Numpad/,m=>m==='Numpad'?'Num ':'');
const PAD_NAMES=['A / Cross','B / Circle','X / Square','Y / Triangle','LB / L1','RB / R1','LT / L2','RT / R2','Back / Select','Start','Left stick press','Right stick press','D-pad ↑','D-pad ↓','D-pad ←','D-pad →','Home'];
const padName=i=>PAD_NAMES[i]||`Button ${i}`;
const keysOf=a=>(keyBinds[a]||[]).filter((c,i,l)=>!(c==='ShiftRight'&&l.includes('ShiftLeft'))).map(keyName).join(' / ')||'—';
function renderHelp(){const k=a=>keysOf(a),g=a=>(padBinds[a]||[]).map(padName).join(' / ')||'—',el=$('controls-help');el.replaceChildren();
 const rows=[['X pad',[4,7,5,6].map(k).join(' ')],['Y pad',[13,11,12,10].map(k).join(' ')],['Buttons',`A = ${k(8)} · B = ${k(0)}`],['Start',`${k(3)} · Rotate: ${k(2)}`],['Fast forward',`hold ${k('ff')}`],['Vertical games','the pads swap, turned with the screen: the X pad keys move (with the Y pad), the Y pad keys are the X1–X4 buttons'],['Quick save / load','F5 / F7 · slot: 1 / 2 / 3'],
  ['Gamepad',`X pad: left stick or ${[4,7,5,6].map(g).join(', ')} · A: ${g(8)} · B: ${g(0)} · Start: ${g(3)} · Rotate: ${g(2)} · Y pad: ${[13,11,12,10].map(g).join(', ')} · fast forward: ${g('ff')}`]];
 rows.forEach(([t,v],i)=>{const b=document.createElement('b');b.textContent=t+':';el.append(b,' '+v);if(i<rows.length-1)el.append(document.createElement('br'));});}
let capture=null;// {kind:'key'|'pad', action, stop}
function renderKeysDialog(){const tb=$('keys-rows');tb.replaceChildren();for(const [a,label] of ACTIONS){const tr=document.createElement('tr'),th=document.createElement('th');th.textContent=label;tr.append(th);
 for(const kind of ['key','pad']){const td=document.createElement('td'),b=document.createElement('button');b.type='button';b.className='bind';b.dataset.kind=kind;b.dataset.action=String(a);
  b.textContent=kind==='key'?keysOf(a):((padBinds[a]||[]).map(padName).join(' / ')||'—');b.onclick=()=>startCapture(kind,a,b);td.append(b);tr.append(td);}tb.append(tr);}}
function saveBinds(){savePref('keys',JSON.stringify(keyBinds));savePref('pad',JSON.stringify(padBinds));buildKeyMap();renderHelp();renderKeysDialog();}
function stopCapture(){if(!capture)return;capture.stop?.();capture=null;renderKeysDialog();}
function startCapture(kind,action,button){stopCapture();button.textContent=kind==='key'?'Press a key… (Esc cancels)':'Press a gamepad button… (Esc cancels)';button.classList.add('waiting');
 const assign=(binds,value)=>{for(const k of Object.keys(binds))binds[k]=(binds[k]||[]).filter(v=>v!==value);binds[action]=[value];saveBinds();};
 if(kind==='key'){const onKey=e=>{e.preventDefault();e.stopImmediatePropagation();if(e.code==='Escape'){stopCapture();return;}
   if(RESERVED_KEYS.has(e.code)){button.textContent=`${keyName(e.code)} is reserved – press another key`;return;}const c=capture;capture=null;c.stop();assign(keyBinds,e.code);};
  window.addEventListener('keydown',onKey,true);capture={kind,action,stop:()=>window.removeEventListener('keydown',onKey,true)};}
 else{const held=new Set();for(const p of navigator.getGamepads?.()||[])if(p)p.buttons.forEach((b,i)=>{if(b.pressed)held.add(i)});let raf=0;const t0=performance.now();
  const onEsc=e=>{if(e.code==='Escape'){e.preventDefault();e.stopImmediatePropagation();stopCapture();}};window.addEventListener('keydown',onEsc,true);
  const poll=()=>{for(const p of navigator.getGamepads?.()||[]){if(!p)continue;for(let i=0;i<p.buttons.length;i++){if(p.buttons[i].pressed&&!held.has(i)){const c=capture;capture=null;c.stop();assign(padBinds,i);return;}if(!p.buttons[i].pressed)held.delete(i);}}
   if(performance.now()-t0>15000){stopCapture();return;}raf=requestAnimationFrame(poll);};raf=requestAnimationFrame(poll);
  capture={kind,action,stop:()=>{cancelAnimationFrame(raf);window.removeEventListener('keydown',onEsc,true);}};}}
$('remap').onclick=()=>{clearInput();renderKeysDialog();$('keys-dialog').showModal();};// keys are ignored while it is open
$('keys-reset').onclick=()=>{stopCapture();keyBinds={...DEFAULT_KEYS};padBinds={...DEFAULT_PAD};saveBinds();message('Keys and gamepad buttons reset');};
$('keys-dialog').addEventListener('close',()=>stopCapture());// not clearInput(): the event can come after the next key press
$('keys-dialog').addEventListener('cancel',e=>{if(capture){e.preventDefault();stopCapture();}});
window.addEventListener('blur',()=>{clearInput();ffKey=ffTouch=false;});
{const ffb=$('ff'),on=e=>{e.preventDefault();ffb.setPointerCapture?.(e.pointerId);ffTouch=true;ffb.classList.add('pressed');},off=e=>{e.preventDefault();ffTouch=false;ffb.classList.remove('pressed');};
 ffb.addEventListener('pointerdown',on);for(const t of ['pointerup','pointercancel','lostpointercapture'])ffb.addEventListener(t,off);}
/* Quick-save slots (F5 save, F7 load, 1-3 choose), kept in this browser per ROM and per core. */
const slotKey=n=>`${romKey}|${coreName}|${n}`;
async function refreshSlots(){const sel=$('slot');for(let n=1;n<=3;n++){let label=`Slot ${n}`;try{const s=romLoaded&&await retrieve(slotKey(n),'states');if(s?.time)label+=` · ${new Date(s.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;else if(romLoaded)label+=' · empty';}catch{}sel.options[n-1].textContent=label;}sel.value=String(slot);}
function selectSlot(n){slot=n;$('slot').value=String(n);message(`Quick-save slot ${n}`);}
async function quickSave(){if(!romLoaded)return;try{const bytes=await core.call('saveState');if(!bytes?.length)throw Error('state save failed');
 await store(slotKey(slot),{state:bytes,time:Date.now(),rom:romName},'states');await refreshSlots();message(`Saved to slot ${slot} (${CORES[coreName].label})`);}catch(e){console.error(e);message('Quick save failed: '+e.message);}}
async function quickLoad(){if(!romLoaded)return;try{const s=await retrieve(slotKey(slot),'states');if(!s?.state){message(`Slot ${slot} is empty for this ROM on ${CORES[coreName].label}`);return;}
 const ok=await core.call('loadState',{bytes:s.state});message(ok?`Loaded slot ${slot}`:`Slot ${slot} could not be loaded`);bank=0;}catch(e){console.error(e);message('Quick load failed: '+e.message);}}
$('qsave').onclick=quickSave;$('qload').onclick=quickLoad;$('slot').onchange=e=>{slot=+e.target.value;e.target.blur();};
/* A patch file from this computer (.bps / .ips, recognised by its header), applied to the ROM as it
 * was loaded - before any catalog patch - so a work-in-progress translation can be tried at once.
 * BPS checks that it is made for this ROM; IPS cannot. */
$('patch-file').onchange=async e=>{const f=e.target.files[0];e.target.value='';if(!f)return;if(!romLoaded||!original){message('Load a ROM first, then apply a patch file to it');return;}
 try{const p=new Uint8Array(await f.arrayBuffer());const head=new TextDecoder().decode(p.subarray(0,5));const format=head.startsWith('BPS1')?'bps':head==='PATCH'?'ips':null;
  if(!format)throw Error(`${f.name} is not a BPS or IPS patch`);
  const out=SwanPatches.apply(original.bytes,p,{format});const ext=(original.name.match(/\.[^.]+$/)||['.wsc'])[0];
  await startRom(out,`${original.name.replace(/\.[^.]+$/,'')} [${f.name.replace(/\.[^.]+$/,'')}]${ext}`,` · patched with local file ${f.name}`);}
 catch(err){console.warn(err);message(`Patch ${f.name} failed: ${err.message}`);}};
/* Touch pads: each pad is one touch area. The thumb's position from its centre gives up to two
 * directions (8 ways, with diagonals), and it follows the thumb as it slides, so it never has to be
 * lifted; both pads and the buttons work at once (one finger each).
 * Analog stick (option, left pad): the centre is where the thumb lands; pushing gives the direction,
 * which changes only once the thumb is clearly in the next 45° sector (no flicker at the edges); past
 * the rim the centre follows the thumb, so turning back is immediate. */
const SECTORS=[['right'],['right','down'],['down'],['down','left'],['left'],['left','up'],['up'],['up','right']];
const stickPad=document.querySelector('.touch-controls .dpad');// the left pad: X pad, the moving one in vertical games
let stickOn=pref('stick','0')==='1';
function applyStick(){stickPad.classList.toggle('stick-mode',stickOn);$('opt-stick').checked=stickOn;}
for(const pad of document.querySelectorAll('.dpad')){
 const bit={};for(const d of ['up','right','down','left'])bit[d]=Number(pad.querySelector('.'+d).dataset.bit);
 const knob=pad===stickPad?Object.assign(document.createElement('span'),{className:'knob'}):null;if(knob)pad.append(knob);
 const fingers=new Map();let held=new Set();
 const padDirs=e=>{const r=pad.getBoundingClientRect(),dx=e.clientX-(r.left+r.width/2),dy=e.clientY-(r.top+r.height/2);
  if(Math.hypot(dx,dy)<Math.min(r.width,r.height)*.14)return [];// the centre: no direction
  return SECTORS[((Math.round(Math.atan2(dy,dx)/(Math.PI/4))%8)+8)%8];};
 const stickDirs=(f,e)=>{const r=pad.getBoundingClientRect(),R=Math.min(r.width,r.height)*.38;
  let dx=e.clientX-f.ox,dy=e.clientY-f.oy,d=Math.hypot(dx,dy);
  if(d>R){f.ox=e.clientX-dx/d*R;f.oy=e.clientY-dy/d*R;dx=dx/d*R;dy=dy/d*R;d=R;}// the centre follows past the rim
  knob.style.setProperty('--kx',`${dx}px`);knob.style.setProperty('--ky',`${dy}px`);
  if(d<Math.max(6,R*.22)){f.sector=-1;return [];}
  const a=Math.atan2(dy,dx)/(Math.PI/4);// in sectors
  if(f.sector>=0){let diff=Math.abs(a-f.sector)%8;if(diff>4)diff=8-diff;if(diff<.5+.15)return SECTORS[f.sector];}
  f.sector=((Math.round(a)%8)+8)%8;return SECTORS[f.sector];};
 const update=()=>{const now=new Set([...fingers.values()].flatMap(f=>f.dirs));
  for(const d of held)if(!now.has(d)){release(bit[d]);pad.querySelector('.'+d).classList.remove('pressed');}
  for(const d of now)if(!held.has(d)){press(bit[d]);pad.querySelector('.'+d).classList.add('pressed');}
  held=now;};
 pad.addEventListener('pointerdown',e=>{e.preventDefault();try{pad.setPointerCapture(e.pointerId);}catch{}
  const f={ox:e.clientX,oy:e.clientY,sector:-1,stick:pad===stickPad&&stickOn,dirs:[]};f.dirs=f.stick?stickDirs(f,e):padDirs(e);
  fingers.set(e.pointerId,f);pad.classList.toggle('stick-active',f.stick);update();});
 pad.addEventListener('pointermove',e=>{const f=fingers.get(e.pointerId);if(!f)return;e.preventDefault();f.dirs=f.stick?stickDirs(f,e):padDirs(e);update();});
 const lift=e=>{if(!fingers.delete(e.pointerId))return;if(knob&&!fingers.size){knob.style.setProperty('--kx','0px');knob.style.setProperty('--ky','0px');pad.classList.remove('stick-active');}update();};
 for(const t of ['pointerup','pointercancel','lostpointercapture'])pad.addEventListener(t,lift);}
$('opt-stick').onchange=e=>{stickOn=e.target.checked;savePref('stick',stickOn?'1':'0');applyStick();message(stickOn?'Analog stick on for the left touch pad':'Left touch pad: four buttons');};
applyStick();
for(const button of document.querySelectorAll('[data-bit]')){if(button.closest('.dpad'))continue;const b=Number(button.dataset.bit);const down=e=>{e.preventDefault();try{button.setPointerCapture?.(e.pointerId);}catch{}press(b);button.classList.add('pressed');};const up=e=>{e.preventDefault();release(b);button.classList.remove('pressed');};button.addEventListener('pointerdown',down);button.addEventListener('pointerup',up);button.addEventListener('pointercancel',up);button.addEventListener('lostpointercapture',up);}
document.addEventListener('visibilitychange',()=>{if(document.hidden){persistRam().catch(console.warn);bank=0;}});
window.addEventListener('pagehide',()=>{persistRam().catch(()=>{});});
/* Core options. 60 Hz mode makes the Mednafen core output 60.38 fps (4 of
 * every 5 frames, audio kept continuous) so motion is even on 60 Hz displays.
 * ares and Mesen have no such mode: they always run at the native 75.47 Hz. */
function pref(key,fallback){try{return localStorage.getItem('swanweb.'+key)??fallback}catch{return fallback}}
function savePref(key,value){try{localStorage.setItem('swanweb.'+key,value)}catch{}}
/* Screen options. Mesen and ares can imitate the LCD - its colour response and the blending of each
 * frame with the previous one - each with its own default (ares: on, Mesen: off). Integer scaling
 * enlarges the picture by a whole number only, so every console pixel has the same size. */
const SCREEN_OPTS={mesen:{lcd:['mesen_ws_lcd_adjust_colors','0'],blend:['mesen_ws_blend_frames','0']},ares:{lcd:['ares_color_emulation','1'],blend:['ares_interframe_blending','1']}};
function applyScreen(){const o=SCREEN_OPTS[coreName];for(const k of ['lcd','blend']){const box=$('opt-'+k);box.disabled=!o;box.checked=!!o&&pref(`${k}.${coreName}`,o[k][1])==='1';if(o&&core)setOption(o[k][0],box.checked?'enabled':'disabled');}
 $('opt-screen-note').hidden=!!o;$('opt-integer').checked=pref('integer','0')==='1';fitCanvas();}
function fitCanvas(){const w=canvas.width,h=canvas.height;if(pref('integer','0')!=='1'||!w||!h){canvas.style.width=canvas.style.height='';return;}
 const wrap=canvas.parentElement,full=isFull(),aw=wrap.clientWidth-(full?0:16),ah=full?wrap.clientHeight:Math.min(window.innerHeight*.7,canvas.classList.contains('portrait')?560:9999);
 const s=Math.max(1,Math.floor(Math.min(aw/w,ah/h)));canvas.style.width=`${w*s}px`;canvas.style.height=`${h*s}px`;}
window.addEventListener('resize',fitCanvas);document.addEventListener('fullscreenchange',fitCanvas);
function applyOptions(){$('opt-patches').checked=pref('patches','1')==='1';applyScreen();if(!core)return;const on=pref('60hz','1')==='1';$('opt-60hz').checked=on;setOption('wswan_60hz_mode',on?'enabled':'disabled');}
for(const k of ['lcd','blend'])$('opt-'+k).onchange=e=>{savePref(`${k}.${coreName}`,e.target.checked?'1':'0');applyScreen();message(`${k==='lcd'?'LCD colours':'Frame blending'} ${e.target.checked?'on':'off'} (${CORES[coreName].label})`);};
$('fps-toggle').onclick=e=>{const on=pref('showfps','0')!=='1';savePref('showfps',on?'1':'0');showFps(on);e.currentTarget.blur();};
showFps(pref('showfps','0')==='1');
$('opt-integer').onchange=e=>{savePref('integer',e.target.checked?'1':'0');fitCanvas();};
$('opt-patches').onchange=e=>{savePref('patches',e.target.checked?'1':'0');message(e.target.checked?'Translation patches will be offered':'Translation patch lookup off');};
/* The picker gives the keyboard back to the game: a focused radio button would take the arrow keys. */
for(const r of document.querySelectorAll('input[name=core]'))r.onchange=e=>{e.target.blur();if(!e.target.checked)return;
 if(current&&systemOf(current.name)!=='ws'&&e.target.value!=='mesen'){showCore(coreName);message('This game runs only with Mesen');return;}
 switchedFrom='';savePref('emulator',e.target.value);useCore(e.target.value);};
$('opt-60hz').onchange=e=>{savePref('60hz',e.target.checked?'1':'0');applyOptions();bank=0;message(e.target.checked?'60 Hz mode on':'Native 75 Hz mode');};
buildKeyMap();renderHelp();
requestAnimationFrame(loop);startup();
