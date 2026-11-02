// SPDX-License-Identifier: GPL-2.0-only
/* Independent HTML5 frontend for two WonderSwan emulator cores compiled to
 * WebAssembly: Beetle WonderSwan (Mednafen, libretro ABI) and ares. Both export
 * the same small ws_* C API, so the page can switch between them, keeping the
 * running game. All game content stays in this browser. No RetroArch runtime. */
'use strict';
const $=id=>document.getElementById(id);
const canvas=$('screen'),ctx=canvas.getContext('2d',{alpha:false});
ctx.imageSmoothingEnabled=false;
const overlay=$('overlay'), status=$('status');
let wasm=null, api=null, running=false, paused=false, romName='', romKey='', romLoaded=false;
/* The emulator cores. Each is loaded the first time it is chosen and kept. */
const CORES={beetle:{label:'Mednafen',script:'./core.js',factory:'createWonderSwan'},ares:{label:'ares',script:'./core-ares.js',factory:'createAres'}};
const instances={};let coreName='',coreBusy=false,current=null;// current: the running game {bytes,name,note}
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
function enabled(v){for(const id of ['pause','reset','sound','export-save','export-state'])$(id).disabled=!v}
function drawWelcome(){ctx.fillStyle='#10192d';ctx.fillRect(0,0,224,144);ctx.strokeStyle='#2a4474';for(let i=0;i<224;i+=16){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,144);ctx.stroke()}for(let i=0;i<144;i+=16){ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(224,i);ctx.stroke()}}
drawWelcome();
function bindApi(m){const c=(name,ret,args)=>m.cwrap(name,ret,args);return{
 prepare:m._ws_prepare_state?c('ws_prepare_state',null,[]):()=>{},
 init:c('ws_init','number',[]),load:c('ws_load','number',['number','number']),unload:c('ws_unload',null,[]),run:c('ws_run',null,[]),input:c('ws_set_input',null,['number']),width:c('ws_get_width','number',[]),height:c('ws_get_height','number',[]),video:c('ws_get_video','number',[]),audio:c('ws_get_audio','number',[]),frames:c('ws_get_audio_frames','number',[]),rate:c('ws_get_sample_rate','number',[]),fps:c('ws_get_fps','number',[]),reset:c('ws_reset',null,[]),saveSize:c('ws_get_save_size','number',[]),save:c('ws_get_save','number',[]),setSave:c('ws_set_save','number',['number','number']),stateSize:c('ws_get_state_size','number',[]),saveState:c('ws_save_state','number',['number','number']),loadState:c('ws_load_state','number',['number','number']),setOption:c('ws_set_option','number',['string','string'])};}
function loadScript(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=()=>reject(Error(src.slice(2)+' is missing. Build the project with Emscripten first.'));document.head.append(s);});}
async function coreInstance(name){if(instances[name])return instances[name];const c=CORES[name];
 if(typeof window[c.factory]!=='function')await loadScript(c.script);
 const m=await window[c.factory]({locateFile:path=>'./'+path,printErr:console.error});const a=bindApi(m);a.init();return instances[name]={wasm:m,api:a};}
function showCore(name){for(const r of document.querySelectorAll('input[name=core]'))r.checked=r.value===name;const ares=name==='ares';$('opt-60hz').disabled=ares;$('opt-60hz-note').hidden=!ares;}
/* Switch emulator core. A running game moves to the new core with its battery save. */
async function useCore(name){if(!CORES[name]||name===coreName||coreBusy){showCore(coreName);return;}coreBusy=true;const wasPaused=paused;paused=true;
 try{message(`Loading ${CORES[name].label} WASM…`);const next=await coreInstance(name);
  if(romLoaded){await persistRam();api.unload();romLoaded=false;enabled(false);}
  ({wasm,api}=next);coreName=name;savePref('core',name);showCore(name);applyOptions();
  if(current){try{await startRom(current.bytes,current.name,current.note);paused=wasPaused;$('pause').textContent=paused?'Resume':'Pause';}
   catch(e){console.warn(e);current=null;overlay.hidden=false;message(`${CORES[name].label} core ready. It could not run the previous game (${e.message}); choose a ROM.`);}}
  else message(`${CORES[name].label} core ready. Choose a .ws, .wsc or .pc2 ROM, or a .zip / .7z containing one.`);}
 catch(e){console.error(e);message(`${CORES[name].label} core unavailable: ${e.message}`);showCore(coreName);if(!api)overlay.textContent='BUILD THE WASM CORE FIRST';paused=wasPaused;}
 finally{coreBusy=false;}}
function startup(){const q=new URLSearchParams(location.search).get('core');const name=CORES[q]?q:(CORES[pref('core','beetle')]?pref('core','beetle'):'beetle');showCore(name);useCore(name);}
function render(){const w=api.width(),h=api.height();if(!w||!h||w>512||h>512)return;if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;canvas.classList.toggle('portrait',h>w);ctx.imageSmoothingEnabled=false;}const n=w*h*4,ptr=api.video();if(!ptr||ptr+n>wasm.HEAPU8.byteLength)return;const pixels=new Uint8ClampedArray(wasm.HEAPU8.buffer,ptr,n);ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels),w,h),0,0);}
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
function pollPad(){gamepadBits=0;for(const p of navigator.getGamepads?.()||[]){if(!p||!p.connected)continue;const pressed=i=>!!p.buttons[i]?.pressed;const axis=(i)=>p.axes[i]||0;const B=(i)=>{gamepadBits|=1<<i};if(pressed(12)||axis(1)<-.5)B(4);if(pressed(13)||axis(1)>.5)B(5);if(pressed(14)||axis(0)<-.5)B(6);if(pressed(15)||axis(0)>.5)B(7);if(pressed(0))B(8);if(pressed(1))B(0);if(pressed(9))B(3);if(pressed(8))B(2);if(pressed(4))B(10);if(pressed(5))B(11);if(pressed(6))B(13);if(pressed(7))B(12);break;}}
function loop(now){requestAnimationFrame(loop);if(!romLoaded||paused||!api){lastFrame=now;return;}frameDuration=1000/(api.fps()||75.47);const dt=Math.min(now-lastFrame,100);lastFrame=now;bank+=dt;pollPad();setButtons();let steps=0;while(bank>=frameDuration&&steps<4){api.input(inputMask());api.run();tickLatch();feedAudio();bank-=frameDuration;steps++;}if(steps){render();$('fps').textContent=`${api.width()}×${api.height()} · ${api.fps().toFixed(2)} Hz`;}if(now-lastAutosave>10000){lastAutosave=now;persistRam().catch(console.warn);}}
function copyOut(ptr,n){if(!ptr||!n||ptr+n>wasm.HEAPU8.byteLength)return null;return new Uint8Array(wasm.HEAPU8.subarray(ptr,ptr+n));}
function allocateBytes(bytes,cb){let ptr=wasm._malloc(bytes.length||1);if(!ptr)throw Error('Out of WASM memory');try{wasm.HEAPU8.set(bytes,ptr);return cb(ptr,bytes.length);}finally{wasm._free(ptr);}}
async function digest(bytes){const hash=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash)).map(x=>x.toString(16).padStart(2,'0')).join('');}
function openDB(){return new Promise((resolve,reject)=>{if(!indexedDB){resolve(null);return;}const req=indexedDB.open('swanweb-save-v1',1);req.onupgradeneeded=()=>req.result.createObjectStore('sram');req.onerror=()=>reject(req.error);req.onsuccess=()=>resolve(req.result);});}
async function store(key,bytes){if(!key||!bytes?.length)return;const db=await openDB();if(!db)return;await new Promise((resolve,reject)=>{const tx=db.transaction('sram','readwrite');tx.objectStore('sram').put(bytes,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();}
async function retrieve(key){const db=await openDB();if(!db)return null;const data=await new Promise((resolve,reject)=>{const tx=db.transaction('sram');const req=tx.objectStore('sram').get(key);req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error)});db.close();return data;}
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
 enabled(true);paused=false;$('pause').textContent='Pause';bank=0;nextAudioTime=0;audioNode?.port.postMessage('reset');overlay.hidden=true;}
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
window.addEventListener('keydown',e=>{if(/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)||document.querySelector('dialog[open]'))return;const b=keyMap[e.code];if(b!==undefined){if(romLoaded)e.preventDefault();if(!e.repeat)press(b);}});
window.addEventListener('keyup',e=>{const b=keyMap[e.code];if(b!==undefined)release(b);});
window.addEventListener('blur',clearInput);
for(const button of document.querySelectorAll('[data-bit]')){const b=Number(button.dataset.bit);const down=e=>{e.preventDefault();button.setPointerCapture?.(e.pointerId);press(b);button.classList.add('pressed');};const up=e=>{e.preventDefault();release(b);button.classList.remove('pressed');};button.addEventListener('pointerdown',down);button.addEventListener('pointerup',up);button.addEventListener('pointercancel',up);button.addEventListener('lostpointercapture',up);}
document.addEventListener('visibilitychange',()=>{if(document.hidden){persistRam().catch(console.warn);bank=0;}});
window.addEventListener('pagehide',()=>{persistRam().catch(()=>{});});
/* Core options. 60 Hz mode makes the Mednafen core output 60.38 fps (4 of
 * every 5 frames, audio kept continuous) so motion is even on 60 Hz displays.
 * ares has no such mode: it always runs at the native 75.47 Hz. */
function pref(key,fallback){try{return localStorage.getItem('swanweb.'+key)??fallback}catch{return fallback}}
function savePref(key,value){try{localStorage.setItem('swanweb.'+key,value)}catch{}}
function applyOptions(){$('opt-patches').checked=pref('patches','1')==='1';if(!api)return;const on=pref('60hz','1')==='1';$('opt-60hz').checked=on;api.setOption('wswan_60hz_mode',on?'enabled':'disabled');}
$('opt-patches').onchange=e=>{savePref('patches',e.target.checked?'1':'0');message(e.target.checked?'Translation patches will be offered':'Translation patch lookup off');};
for(const r of document.querySelectorAll('input[name=core]'))r.onchange=e=>{if(e.target.checked)useCore(e.target.value);};
$('opt-60hz').onchange=e=>{savePref('60hz',e.target.checked?'1':'0');applyOptions();bank=0;message(e.target.checked?'60 Hz mode on':'Native 75 Hz mode');};
requestAnimationFrame(loop);startup();
