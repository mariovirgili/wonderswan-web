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
let wasm=null, api=null, running=false, paused=false, romName='', romKey='', romLoaded=false;
/* The emulator cores. Each is loaded the first time it is chosen and kept. */
const CORES={beetle:{label:'Mednafen',script:'./core.js',factory:'createWonderSwan'},ares:{label:'ares',script:'./core-ares.js',factory:'createAres'},mesen:{label:'Mesen',script:'./core-mesen.js',factory:'createMesen'}};
const instances={};let coreName='',coreBusy=false,current=null;// current: the running game {bytes,name,note}
let original=null;// the ROM as loaded, before any patch {bytes,name}: a local patch file is applied to it
let fastForward=false,ffKey=false,ffTouch=false,slot=1;
let frameDuration=1000/75.47, lastFrame=0, bank=0, buttons=0, gamepadBits=0;
let audioContext=null, nextAudioTime=0, volume=.6, lastAutosave=0;
let audioGain=null, audioNode=null, soundOn=false, workletRate=0;
const keyMap={ArrowUp:4,ArrowDown:5,ArrowLeft:6,ArrowRight:7,KeyW:13,KeyS:12,KeyA:10,KeyD:11,KeyX:8,KeyZ:0,Enter:3,ShiftLeft:2,ShiftRight:2};
function message(t){status.textContent=t}
/* Input latch: a press is held for at least LATCH_FRAMES emulated frames,
 * so taps shorter than a frame (or than the game's polling interval) are not lost. */
const LATCH_FRAMES=6, latch=new Uint8Array(32);
function press(b){buttons|=1<<b;latch[b]=LATCH_FRAMES;setButtons();}
function release(b){buttons&=~(1<<b);setButtons();}
function inputMask(){let m=buttons|gamepadBits;for(let i=0;i<32;i++)if(latch[i])m|=1<<i;return m>>>0;}
function tickLatch(){for(let i=0;i<32;i++)if(latch[i])latch[i]--;}
function clearInput(){buttons=0;latch.fill(0);setButtons();}
function setButtons(){if(api)api.input(inputMask())}
function enabled(v){for(const id of ['pause','reset','sound','export-save','export-state','qsave','qload','patch-file','ff'])$(id).disabled=!v;$('patch-file-label').classList.toggle('disabled',!v);}
function drawWelcome(){ctx.fillStyle='#10192d';ctx.fillRect(0,0,224,144);ctx.strokeStyle='#2a4474';for(let i=0;i<224;i+=16){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,144);ctx.stroke()}for(let i=0;i<144;i+=16){ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(224,i);ctx.stroke()}}
drawWelcome();
function bindApi(m){const c=(name,ret,args)=>m.cwrap(name,ret,args);return{
 prepare:m._ws_prepare_state?c('ws_prepare_state',null,[]):()=>{},
 init:c('ws_init','number',[]),load:c('ws_load','number',['number','number']),unload:c('ws_unload',null,[]),run:c('ws_run',null,[]),input:c('ws_set_input',null,['number']),width:c('ws_get_width','number',[]),height:c('ws_get_height','number',[]),video:c('ws_get_video','number',[]),audio:c('ws_get_audio','number',[]),frames:c('ws_get_audio_frames','number',[]),rate:c('ws_get_sample_rate','number',[]),fps:c('ws_get_fps','number',[]),reset:c('ws_reset',null,[]),saveSize:c('ws_get_save_size','number',[]),save:c('ws_get_save','number',[]),setSave:c('ws_set_save','number',['number','number']),stateSize:c('ws_get_state_size','number',[]),saveState:c('ws_save_state','number',['number','number']),loadState:c('ws_load_state','number',['number','number']),setOption:c('ws_set_option','number',['string','string'])};}
function loadScript(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=()=>reject(Error(src.slice(2)+' is missing. Build the project with Emscripten first.'));document.head.append(s);});}
async function coreInstance(name){if(instances[name])return instances[name];const c=CORES[name];
 if(typeof window[c.factory]!=='function')await loadScript(c.script);
 /* A core's stderr: Mesen's libretro front end reports normal progress there ('[libretro] …'). */
 const m=await window[c.factory]({locateFile:path=>'./'+path,printErr:t=>/^\[libretro\]/.test(t)?console.debug(t):console.error(t)});const a=bindApi(m);a.init();return instances[name]={wasm:m,api:a};}
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
  if(romLoaded){await persistRam();api.unload();romLoaded=false;enabled(false);}
  ({wasm,api}=next);coreName=name;showCore(name);applyOptions();
  if(current){try{await startRom(current.bytes,current.name,current.note);paused=wasPaused;$('pause').textContent=paused?'Resume':'Pause';}
   catch(e){console.warn(e);current=null;overlay.hidden=false;message(`${CORES[name].label} core ready. It could not run the previous game (${e.message}); choose a ROM.`);}}
  else message(`${CORES[name].label} core ready. Choose a .ws, .wsc or .pc2 ROM, or a .zip / .7z containing one.`);}
 catch(e){console.error(e);message(`${CORES[name].label} core unavailable: ${e.message}`);showCore(coreName);if(!api)overlay.textContent='BUILD THE WASM CORE FIRST';paused=wasPaused;}
 finally{coreBusy=false;}}
/* Mesen is the default (the fastest in the browser). Only a choice made in the picker is remembered
 * ('swanweb.emulator'; the older 'swanweb.core' also stored the default and is ignored). */
const DEFAULT_CORE='mesen';
function startup(){const q=new URLSearchParams(location.search).get('core'),saved=pref('emulator','');const name=CORES[q]?q:(CORES[saved]?saved:DEFAULT_CORE);showCore(name);useCore(name);}
function render(){const w=api.width(),h=api.height();if(!w||!h||w>512||h>512)return;if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;canvas.classList.toggle('portrait',h>w);ctx.imageSmoothingEnabled=false;fitCanvas();}const n=w*h*4,ptr=api.video();if(!ptr||ptr+n>wasm.HEAPU8.byteLength)return;const pixels=new Uint8ClampedArray(wasm.HEAPU8.buffer,ptr,n);ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels),w,h),0,0);}
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
async function startAudio(){const rate=api&&api.rate()>8000?api.rate():44100;
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
function feedAudio(){if(!soundOn||!audioContext||audioContext.state!=='running')return;const n=api.frames();if(!n)return;const rate=api.rate();if(!(rate>8000))return;const ptr=api.audio();if(!ptr||ptr+4*n>wasm.HEAPU8.byteLength)return;
 const input=new Int16Array(wasm.HEAPU8.buffer,ptr,n*2);
 if(audioNode){if(rate!==workletRate){workletRate=rate;audioNode.port.postMessage(audioConfig(rate));}
  const f=new Float32Array(n*2);for(let i=0;i<n*2;i++)f[i]=input[i]/32768;audioNode.port.postMessage(f,[f.buffer]);return;}
 const output=audioContext.createBuffer(2,n,rate),left=output.getChannelData(0),right=output.getChannelData(1);for(let i=0;i<n;i++){left[i]=input[i*2]/32768;right[i]=input[i*2+1]/32768;}
 const src=audioContext.createBufferSource();src.buffer=output;src.connect(audioGain);const now=audioContext.currentTime;if(nextAudioTime<now||nextAudioTime-now>.20)nextAudioTime=now+.035;src.start(nextAudioTime);nextAudioTime+=n/rate;src.onended=()=>src.disconnect();}
let gamepadFF=false;
function pollPad(){gamepadBits=0;gamepadFF=false;for(const p of navigator.getGamepads?.()||[]){if(!p||!p.connected)continue;const pressed=i=>!!p.buttons[i]?.pressed;const axis=(i)=>p.axes[i]||0;const B=(i)=>{gamepadBits|=1<<i};if(pressed(12)||axis(1)<-.5)B(4);if(pressed(13)||axis(1)>.5)B(5);if(pressed(14)||axis(0)<-.5)B(6);if(pressed(15)||axis(0)>.5)B(7);if(pressed(0))B(8);if(pressed(1))B(0);if(pressed(9))B(3);if(pressed(8))B(2);if(pressed(4))B(10);if(pressed(5))B(11);if(pressed(6))B(13);if(pressed(7))B(12);if(pressed(10)||pressed(11))gamepadFF=true;break;}}
/* Fast forward (hold Space or the ⏩ button): up to FF_SPEED× speed, as far as the CPU allows within
 * one display refresh; the sound is skipped meanwhile. */
const FF_SPEED=4;
function loop(now){requestAnimationFrame(loop);if(!romLoaded||paused||!api){lastFrame=now;return;}frameDuration=1000/(api.fps()||75.47);const dt=Math.min(now-lastFrame,100);lastFrame=now;
 pollPad();setButtons();const ff=fastForward=ffKey||ffTouch||gamepadFF;bank+=ff?dt*FF_SPEED:dt;let steps=0;const t0=performance.now(),maxSteps=ff?FF_SPEED*4:4;
 while(bank>=frameDuration&&steps<maxSteps&&(!ff||steps===0||performance.now()-t0<12)){api.input(inputMask());api.run();tickLatch();if(!ff)feedAudio();bank-=frameDuration;steps++;}
 if(ff)bank=Math.min(bank,frameDuration);
 if(steps){render();$('fps').textContent=`${api.width()}×${api.height()} · ${api.fps().toFixed(2)} Hz${ff?' · ⏩ fast forward':''}`;}if(now-lastAutosave>10000){lastAutosave=now;persistRam().catch(console.warn);}}
function copyOut(ptr,n){if(!ptr||!n||ptr+n>wasm.HEAPU8.byteLength)return null;return new Uint8Array(wasm.HEAPU8.subarray(ptr,ptr+n));}
function allocateBytes(bytes,cb){let ptr=wasm._malloc(bytes.length||1);if(!ptr)throw Error('Out of WASM memory');try{wasm.HEAPU8.set(bytes,ptr);return cb(ptr,bytes.length);}finally{wasm._free(ptr);}}
async function digest(bytes){const hash=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash)).map(x=>x.toString(16).padStart(2,'0')).join('');}
/* IndexedDB: 'sram' (battery saves, by ROM SHA-256) and, since version 2, 'states' (quick-save slots,
 * by ROM SHA-256 + core + slot: a state only fits the core that made it). */
function openDB(){return new Promise((resolve,reject)=>{if(!indexedDB){resolve(null);return;}const req=indexedDB.open('swanweb-save-v1',2);req.onupgradeneeded=()=>{const db=req.result;for(const s of ['sram','states'])if(!db.objectStoreNames.contains(s))db.createObjectStore(s);};req.onerror=()=>reject(req.error);req.onsuccess=()=>resolve(req.result);});}
async function store(key,bytes,os='sram'){if(!key||!(bytes?.length||bytes?.state))return;const db=await openDB();if(!db)return;await new Promise((resolve,reject)=>{const tx=db.transaction(os,'readwrite');tx.objectStore(os).put(bytes,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();}
async function retrieve(key,os='sram'){const db=await openDB();if(!db)return null;const data=await new Promise((resolve,reject)=>{const tx=db.transaction(os);const req=tx.objectStore(os).get(key);req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error)});db.close();return data;}
async function persistRam(){if(!romLoaded||!romKey)return;const n=api.saveSize(),ptr=api.save();if(n&&ptr){const bytes=copyOut(ptr,n);await store(romKey,bytes);}}
/* An archive with several ROMs: let the player choose one. Resolves to {name, bytes} or null. */
function pickRom(archiveName,roms){const dlg=$('rom-dialog'),list=$('rom-list');$('rom-archive').textContent=archiveName;list.replaceChildren();
 roms.forEach((r,k)=>{const l=document.createElement('label');l.className='patch-item';const i=document.createElement('input');i.type='radio';i.name='rom';i.value=String(k);i.checked=k===0;
  const t=document.createElement('span');t.className='patch-text';const s=document.createElement('strong');s.textContent=r.name.split('/').pop();const v=document.createElement('span');v.className='patch-variant';v.textContent=`${r.name} · ${(r.bytes.length/1024).toLocaleString()} KB`;t.append(s,v);l.append(i,t);list.append(l);});
 return new Promise(res=>{dlg.addEventListener('close',()=>{const c=list.querySelector('input[name=rom]:checked');res(dlg.returnValue==='ok'&&c?roms[+c.value]:null);},{once:true});dlg.returnValue='';dlg.showModal();$('rom-ok').focus();});}
async function loadRom(file){if(!file||!api||coreBusy)return;if(!/\.(ws|wsc|pc2|zip|7z)$/i.test(file.name)){message('Unsupported file type: choose a .ws, .wsc, .pc2, .zip or .7z file');return;}
 const wasPaused=paused;try{paused=true;clearInput();let bytes=new Uint8Array(await file.arrayBuffer());let name=file.name,patchNote='';
  if(SwanArchive.isArchive(name)){message(`Opening ${name}…`);const roms=await SwanArchive.extractRoms(name,bytes);if(!roms.length)throw Error(`no .ws/.wsc/.pc2 ROM inside ${name}`);
   const r=roms.length===1?roms[0]:await pickRom(name,roms);if(!r){paused=wasPaused;message('Cancelled');return;}bytes=r.bytes;name=r.name.split('/').pop();}
  original={bytes,name};
  if(pref('patches','1')==='1'&&typeof SwanPatches!=='undefined'){try{const r=await SwanPatches.offer(bytes,name,message);bytes=r.bytes;name=r.name;
    if(r.patch)patchNote=` · patched with ${r.patch.variant}${r.patch.version?' v'+r.patch.version:''}`;
    else if(r.recognised)patchNote=` · recognised: ${r.recognised.game||''} ${r.recognised.variant}${r.recognised.version?' v'+r.recognised.version:''}`;}
   catch(e){console.error(e);patchNote=` · PATCH FAILED (${e.message}), running the original ROM`;}}
  await startRom(bytes,name,patchNote);}
 catch(e){console.error(e);paused=wasPaused;message('Could not load ROM: '+e.message);}}
/* Run a ROM (already patched) on the current core and restore its battery save. */
async function startRom(bytes,name,note){await persistRam();if(romLoaded)api.unload();romLoaded=false;enabled(false);clearInput();
 romKey=await digest(bytes);romName=name;current={bytes,name,note};const ok=allocateBytes(bytes,(ptr,n)=>api.load(ptr,n));if(!ok)throw Error('Core rejected the ROM');romLoaded=true;
 const saved=await retrieve(romKey);if(saved&&saved.length===api.saveSize()){allocateBytes(saved,(ptr,n)=>api.setSave(ptr,n));message(`Loaded ${romName}${note} · battery save restored`);}else message(`Loaded ${romName}${note}`);
 enabled(true);paused=false;$('pause').textContent='Pause';bank=0;nextAudioTime=0;audioNode?.port.postMessage('reset');overlay.hidden=true;refreshSlots();}
function download(bytes,name){if(!bytes?.length){message('No data available to export');return;}const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function stem(){return romName.replace(/\.[^.]+$/,'')||'wonderswan';}
$('rom').addEventListener('change',e=>{loadRom(e.target.files[0]);e.target.value='';});
$('pause').onclick=()=>{paused=!paused;bank=0;$('pause').textContent=paused?'Resume':'Pause';message(paused?'Paused':'Running');};
$('reset').onclick=()=>{api.reset();message('Console reset');};
$('fullscreen').onclick=()=>{if(document.fullscreenElement)document.exitFullscreen();else document.querySelector('.screen-wrap').requestFullscreen?.();};
$('sound').onclick=toggleSound;$('volume').oninput=e=>{volume=Number(e.target.value)/100;if(audioGain)audioGain.gain.value=volume;};
$('export-save').onclick=()=>download(copyOut(api.save(),api.saveSize()),stem()+'.sav');
$('import-save').onchange=async e=>{const f=e.target.files[0];if(f&&romLoaded){const b=new Uint8Array(await f.arrayBuffer());if(allocateBytes(b,(ptr,n)=>api.setSave(ptr,n))){message('SRAM imported');await persistRam();}else message(`SRAM size mismatch; expected ${api.saveSize()} bytes`);}e.target.value='';};
$('export-state').onclick=()=>{api.prepare();const n=api.stateSize();if(!n){message('States unavailable');return;}const ptr=wasm._malloc(n);try{if(api.saveState(ptr,n))download(copyOut(ptr,n),stem()+'.state');else message('State save failed');}finally{wasm._free(ptr);}};
$('import-state').onchange=async e=>{const f=e.target.files[0];if(f&&romLoaded){const b=new Uint8Array(await f.arrayBuffer());try{const ok=allocateBytes(b,(ptr,n)=>api.loadState(ptr,n));message(ok?'State restored':'State rejected (different ROM/core?)');}catch(err){message(err.message)}}e.target.value='';};
window.addEventListener('keydown',e=>{if(/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)||document.querySelector('dialog[open]'))return;
 if(romLoaded){if(e.code==='Space'){e.preventDefault();ffKey=true;return;}
  if(e.code==='F5'||e.code==='F7'){e.preventDefault();if(!e.repeat)(e.code==='F5'?quickSave:quickLoad)();return;}
  const d=/^Digit([1-3])$/.exec(e.code);if(d&&!e.ctrlKey&&!e.altKey&&!e.metaKey){selectSlot(+d[1]);return;}}
 const b=keyMap[e.code];if(b!==undefined){if(romLoaded)e.preventDefault();if(!e.repeat)press(b);}});
window.addEventListener('keyup',e=>{if(e.code==='Space')ffKey=false;const b=keyMap[e.code];if(b!==undefined)release(b);});
window.addEventListener('blur',()=>{clearInput();ffKey=ffTouch=false;});
{const ffb=$('ff'),on=e=>{e.preventDefault();ffb.setPointerCapture?.(e.pointerId);ffTouch=true;ffb.classList.add('pressed');},off=e=>{e.preventDefault();ffTouch=false;ffb.classList.remove('pressed');};
 ffb.addEventListener('pointerdown',on);for(const t of ['pointerup','pointercancel','lostpointercapture'])ffb.addEventListener(t,off);}
/* Quick-save slots (F5 save, F7 load, 1-3 choose), kept in this browser per ROM and per core. */
const slotKey=n=>`${romKey}|${coreName}|${n}`;
async function refreshSlots(){const sel=$('slot');for(let n=1;n<=3;n++){let label=`Slot ${n}`;try{const s=romLoaded&&await retrieve(slotKey(n),'states');if(s?.time)label+=` · ${new Date(s.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;else if(romLoaded)label+=' · empty';}catch{}sel.options[n-1].textContent=label;}sel.value=String(slot);}
function selectSlot(n){slot=n;$('slot').value=String(n);message(`Quick-save slot ${n}`);}
async function quickSave(){if(!romLoaded)return;try{api.prepare();const n=api.stateSize();if(!n)throw Error('states unavailable');const ptr=wasm._malloc(n);let bytes;try{if(!api.saveState(ptr,n))throw Error('state save failed');bytes=copyOut(ptr,n);}finally{wasm._free(ptr);}
 await store(slotKey(slot),{state:bytes,time:Date.now(),rom:romName},'states');await refreshSlots();message(`Saved to slot ${slot} (${CORES[coreName].label})`);}catch(e){console.error(e);message('Quick save failed: '+e.message);}}
async function quickLoad(){if(!romLoaded)return;try{const s=await retrieve(slotKey(slot),'states');if(!s?.state){message(`Slot ${slot} is empty for this ROM on ${CORES[coreName].label}`);return;}
 const ok=allocateBytes(s.state,(p,l)=>api.loadState(p,l));message(ok?`Loaded slot ${slot}`:`Slot ${slot} could not be loaded`);bank=0;}catch(e){console.error(e);message('Quick load failed: '+e.message);}}
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
for(const button of document.querySelectorAll('[data-bit]')){const b=Number(button.dataset.bit);const down=e=>{e.preventDefault();button.setPointerCapture?.(e.pointerId);press(b);button.classList.add('pressed');};const up=e=>{e.preventDefault();release(b);button.classList.remove('pressed');};button.addEventListener('pointerdown',down);button.addEventListener('pointerup',up);button.addEventListener('pointercancel',up);button.addEventListener('lostpointercapture',up);}
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
function applyScreen(){const o=SCREEN_OPTS[coreName];for(const k of ['lcd','blend']){const box=$('opt-'+k);box.disabled=!o;box.checked=!!o&&pref(`${k}.${coreName}`,o[k][1])==='1';if(o&&api)api.setOption(o[k][0],box.checked?'enabled':'disabled');}
 $('opt-screen-note').hidden=!!o;$('opt-integer').checked=pref('integer','0')==='1';fitCanvas();}
function fitCanvas(){const w=canvas.width,h=canvas.height;if(pref('integer','0')!=='1'||!w||!h){canvas.style.width=canvas.style.height='';return;}
 const wrap=canvas.parentElement,full=!!document.fullscreenElement,aw=wrap.clientWidth-(full?0:16),ah=full?wrap.clientHeight:Math.min(window.innerHeight*.7,canvas.classList.contains('portrait')?560:9999);
 const s=Math.max(1,Math.floor(Math.min(aw/w,ah/h)));canvas.style.width=`${w*s}px`;canvas.style.height=`${h*s}px`;}
window.addEventListener('resize',fitCanvas);document.addEventListener('fullscreenchange',fitCanvas);
function applyOptions(){$('opt-patches').checked=pref('patches','1')==='1';applyScreen();if(!api)return;const on=pref('60hz','1')==='1';$('opt-60hz').checked=on;api.setOption('wswan_60hz_mode',on?'enabled':'disabled');}
for(const k of ['lcd','blend'])$('opt-'+k).onchange=e=>{savePref(`${k}.${coreName}`,e.target.checked?'1':'0');applyScreen();message(`${k==='lcd'?'LCD colours':'Frame blending'} ${e.target.checked?'on':'off'} (${CORES[coreName].label})`);};
$('opt-integer').onchange=e=>{savePref('integer',e.target.checked?'1':'0');fitCanvas();};
$('opt-patches').onchange=e=>{savePref('patches',e.target.checked?'1':'0');message(e.target.checked?'Translation patches will be offered':'Translation patch lookup off');};
/* The picker gives the keyboard back to the game: a focused radio button would take the arrow keys. */
for(const r of document.querySelectorAll('input[name=core]'))r.onchange=e=>{e.target.blur();if(e.target.checked){savePref('emulator',e.target.value);useCore(e.target.value);}};
$('opt-60hz').onchange=e=>{savePref('60hz',e.target.checked?'1':'0');applyOptions();bank=0;message(e.target.checked?'60 Hz mode on':'Native 75 Hz mode');};
requestAnimationFrame(loop);startup();
