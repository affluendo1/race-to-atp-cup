(()=>{
  const UNLOCK_KEY='brta-module-enabled-v1',INTRO_KEY='brta-archive-intro-seen';
  const archive=document.querySelector('#royalArchive');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const tracks=[
    {title:'Hypnotize · The Notorious B.I.G.',src:'assets/hypnotize.mp3'},
    {title:"Gangsta’s Paradise · Coolio",src:'assets/gangstas-paradise.mp3'}
  ];
  const wins=[
    {event:'ROYAL COURT',name:'S. BASA def. J. BONE',score:'6–0  6–0',src:'assets/sid-vs-jayden-6-0-6-0.png',alt:'Sid Basa defeats Jayden Bone 6–0, 6–0 in the royal court.'},
    {event:'AUSTRALIAN OPEN · 2027',name:'S. BASA def. J. SINNER',score:'6–2  6–0  7–6(4)',src:'assets/sid-ao-2027-vs-sinner.png',alt:'Sid Basa defeats Jannik Sinner in the 2027 Australian Open final.'},
    {event:'ROLAND-GARROS · 2027',name:'S. BASA def. C. ALCARAZ',score:'4–6  6–2  6–3  6–1',src:'assets/sid-rg-2027-vs-alcaraz.png',alt:'Sid Basa defeats Carlos Alcaraz in the 2027 Roland-Garros final.'},
    {event:'WIMBLEDON · 2027',name:'S. BASA def. J. SINNER',score:'6–2  6–4  6–4',src:'assets/sid-wimbledon-2027-vs-sinner.png',alt:'Sid Basa defeats Jannik Sinner in the 2027 Wimbledon final.'},
    {event:'US OPEN · 2027',name:'S. BASA def. N. DJOKOVIC',score:'2–6  6–7(6)  6–3  6–0  6–1',src:'assets/sid-us-open-2027-vs-djokovic.png',alt:'Sid Basa defeats Novak Djokovic in the 2027 US Open final.'}
  ];
  let portalOpen=false,slide=0,track=0,lightboxSlide=-1,audioContext=null,analyser=null,sourceNode=null,animationFrame=0,quoteTimer=0,sidBusy=false,returnFocus=null,touchStart=0,fadeTimer=0;
  const music=new Audio(),gong=new Audio('assets/gong.mp3');music.loop=false;music.preload='metadata';music.volume=.55;gong.preload='auto';
  const archiveMedia=['assets/sid-throne-hero.png','assets/sid-royal-rise-transparent.png','assets/sid-federer-handshake.png','assets/sid-federer-kneeling.png','assets/sid-honour-plaque-transparent.png','assets/sid-wilson-blade-web.png','assets/royal-court-sunset.jpg','assets/royal-crowd-web.jpg',...wins.map(win=>win.src)];
  let archivePreload=null,gongContext=null,gongSource=null,gongGain=null;
  music.addEventListener('ended',()=>{if(portalOpen)setTrack(track+1,true)});

  const unlocked=()=>localStorage.getItem(UNLOCK_KEY)==='1';
  const updateEntry=()=>{};
  const transition=(done,copy)=>{
    if(typeof window.runBRTAInterfaceTransition==='function')window.runBRTAInterfaceTransition(done,copy);
    else done();
  };
  function preloadArchiveMedia(){
    if(archivePreload)return archivePreload;
    archivePreload=Promise.all(archiveMedia.map(src=>new Promise(resolve=>{
      const image=new Image();image.decoding='async';image.onload=image.onerror=resolve;image.src=src;
    })));
    return archivePreload;
  }
  function playRoyalGong(){
    gong.currentTime=0;gong.muted=false;gong.volume=1;
    try{
      const Context=window.AudioContext||window.webkitAudioContext;
      if(Context){
        if(!gongContext){gongContext=new Context();gongSource=gongContext.createMediaElementSource(gong);const compressor=gongContext.createDynamicsCompressor();compressor.threshold.value=-22;compressor.knee.value=12;compressor.ratio.value=8;compressor.attack.value=.003;compressor.release.value=.18;gongGain=gongContext.createGain();gongGain.gain.value=3.6;gongSource.connect(compressor);compressor.connect(gongGain);gongGain.connect(gongContext.destination)}
        if(gongContext.state==='suspended')gongContext.resume();
      }
    }catch{}
    gong.play().catch(()=>{});
  }
  function bindSettings(){
    const show=document.querySelector('#showExtrasBtn'),hide=document.querySelector('#hideExtrasBtn');
    if(show)show.onclick=unlock;
    if(hide)hide.onclick=revokeExtras;
    syncExtrasAccessControls();
  }
  function syncExtrasAccessControls(){const visible=unlocked(),show=document.querySelector('#showExtrasBtn'),hide=document.querySelector('#hideExtrasBtn');show?.classList.toggle('hidden',visible);hide?.classList.toggle('hidden',!visible)}
  function unlock(){
    localStorage.setItem(UNLOCK_KEY,'1');sessionStorage.removeItem(INTRO_KEY);updateEntry();syncExtrasAccessControls();window.dispatchEvent(new Event('brta-module-toggle'));
  }
  function revokeExtras(){
    localStorage.removeItem(UNLOCK_KEY);sessionStorage.removeItem(INTRO_KEY);updateEntry();syncExtrasAccessControls();if(portalOpen)leavePortal();window.dispatchEvent(new Event('brta-module-toggle'));
  }
  document.addEventListener('keydown',event=>{const box=archive.querySelector('[data-lightbox]');if(box?.classList.contains('hidden'))return;if(event.key==='Escape')closeLightbox();else if(event.key==='ArrowLeft'){event.preventDefault();navigateLightbox(-1)}else if(event.key==='ArrowRight'){event.preventDefault();navigateLightbox(1)}});

  const trophySvg=(label,variant)=>`<svg class="royal-trophy trophy-${variant}" viewBox="0 0 120 128" role="img" aria-label="${label} trophy"><path class="trophy-cup" d="M31 13h58v21c0 25-13 41-29 41S31 59 31 34V13Z"/><path class="trophy-handle" d="M31 23H14c0 25 10 38 29 38M89 23h17c0 25-10 38-29 38"/><path class="trophy-stem" d="M60 75v22M40 106h40M48 97h24"/><circle class="trophy-gem" cx="60" cy="40" r="7"/></svg>`;
  const backgroundSymbols=['♛','♕','♚','♔','♛','♕','♚','♔','🎾','🎾','🎾','🎾','🎾','♛','♕','♚','⚜','⚜','✦','✦','✧','♛','🎾','♔'];
  const sideQuotes=['“The court remembers.”','“No throne without footwork.”','“The racket chose him.”','“Four crowns. One season.”','“The baseline bowed first.”','“Monarch of match point.”','“A blade does not blink.”','“History arrived early.”'];
  const archiveCopy=(chunks,...values)=>String.raw({raw:chunks},...values).replaceAll('FICTIONAL ARCHIVE INTERVIEW · 2027','ROYAL ARCHIVE · 2027').replaceAll('FICTIONAL ARCHIVE PRACTICE NOTE · JAYDEN BONE','PRACTICE NOTE · JAYDEN BONE');
  function portalMarkup(){
    const symbols=backgroundSymbols.map((symbol,index)=>{const left=index%2===0,x=left?1+(index*5)%8:91+(index*5)%8;return`<i class="royal-idle-symbol symbol-${index%8}" style="--i:${index};--x:${x};--delay:${-(index%9)*1.2}s" aria-hidden="true">${symbol}</i>`}).join('');
    const quotes=sideQuotes.map((quote,index)=>`<p class="royal-side-quote quote-${index}" style="--q:${index}" aria-hidden="true">${quote}</p>`).join('');
    return archiveCopy`<div class="archive-intro" aria-live="polite" aria-atomic="true" hidden><p>ACCESSING ROYAL ARCHIVE…</p></div><div class="royal-atmosphere" aria-hidden="true">${symbols}</div><div class="royal-quote-field">${quotes}</div>
      <div class="archive-utility"><button class="archive-return" type="button" data-archive-return>Return to ratings</button></div>
      <section class="archive-hero" data-hero><img class="archive-hero-img" src="assets/sid-throne-hero.png" fetchpriority="high" decoding="async" alt="Sid Basa seated on an ornate royal tennis throne."><div class="hero-copy"><div class="archive-kicker">Royal Tennis Archive · 2027</div><h1>SIDDHARTH R. BASA</h1><p>Champion · Monarch · Wielder of the Blade</p></div></section><div class="archive-story">
      <section class="archive-section archive-archives"><h2 class="archive-heading">THE ROYAL ARCHIVES</h2><div class="archive-duo"><figure class="archive-image-frame" data-enlarge-src="assets/sid-federer-handshake.png" data-enlarge-alt="Sid Basa shaking hands with Roger Federer in the royal hall." tabindex="0" role="button" aria-label="Enlarge The Handshake"><img src="assets/sid-federer-handshake.png" decoding="async" width="1672" height="941" alt="Sid Basa shaking hands with Roger Federer in the royal hall."><figcaption>I. The Handshake</figcaption></figure><figure class="archive-image-frame offset" data-enlarge-src="assets/sid-federer-kneeling.png" data-enlarge-alt="Sid Basa holding his racket while Federer kneels in the royal hall." tabindex="0" role="button" aria-label="Enlarge The Recognition"><img src="assets/sid-federer-kneeling.png" decoding="async" width="1672" height="941" alt="Sid Basa holding his racket while Federer kneels in the royal hall."><figcaption>II. The Recognition</figcaption></figure></div><aside class="archive-testimonial testimonial-zverev"><small>FICTIONAL ARCHIVE INTERVIEW · 2027</small><blockquote>“I tried every pattern: higher, flatter, slower, faster. Basa still made the court feel too small. That is not normal tennis.”</blockquote><cite>— Alexander Zverev</cite></aside></section>
      <section class="archive-section archive-wins" aria-labelledby="winsHeading"><h2 id="winsHeading" class="archive-heading">GREATEST WINS</h2><div class="season-line" aria-label="2027 Grand Slam timeline"><button class="ao" type="button" data-slide-jump="1">Melbourne</button><button class="rg" type="button" data-slide-jump="2">Paris</button><button class="wb" type="button" data-slide-jump="3">London</button><button class="us" type="button" data-slide-jump="4">New York</button></div><div class="wins-carousel" data-carousel tabindex="0" aria-roledescription="carousel" aria-label="Greatest wins"><div class="wins-track">${wins.map((win,index)=>`<article class="win-slide${index===0?' active':''}" data-win-slide="${index}" aria-hidden="${index===0?'false':'true'}"><img src="${win.src}" data-enlarge-src="${win.src}" data-enlarge-alt="${win.alt}" width="1672" height="941" alt="${win.alt}" role="button" tabindex="${index===0?'0':'-1'}" decoding="async" aria-label="Enlarge ${win.name}"><div class="win-caption"><small>${win.event}</small><b>${win.name}</b><span>${win.score}</span></div></article>`).join('')}</div><div class="carousel-controls"><button class="carousel-arrow" type="button" data-slide-prev aria-label="Previous win">‹</button><div class="carousel-dots">${wins.map((_,index)=>`<button class="carousel-dot" type="button" data-slide-jump="${index}" aria-label="Show win ${index+1}" aria-current="${index===0?'true':'false'}"></button>`).join('')}</div><button class="carousel-arrow" type="button" data-slide-next aria-label="Next win">›</button></div></div><aside class="archive-testimonial testimonial-sinner"><small>FICTIONAL ARCHIVE INTERVIEW · 2027</small><blockquote>“His ball looked calm, then it was suddenly behind me. The score does not explain how relentless that was.”</blockquote><cite>— Jannik Sinner</cite></aside></section>
      <section class="archive-section archive-crowns"><h2 class="archive-heading">THE FOUR CROWNS</h2><div class="crown-cabinet"><article class="crown-item">${trophySvg('Australian Open 2027','ao')}<small>AO 2027</small><b>Sinner</b><span>6–2  6–0  7–6(4)</span></article><article class="crown-item">${trophySvg('Roland-Garros 2027','rg')}<small>RG 2027</small><b>Alcaraz</b><span>4–6  6–2  6–3  6–1</span></article><article class="crown-item">${trophySvg('Wimbledon 2027','wb')}<small>Wimbledon 2027</small><b>Sinner</b><span>6–2  6–4  6–4</span></article><article class="crown-item">${trophySvg('US Open 2027','us')}<small>US Open 2027</small><b>Djokovic</b><span>2–6  6–7(6)  6–3  6–0  6–1</span></article></div><aside class="archive-testimonial testimonial-alcaraz"><small>FICTIONAL ARCHIVE INTERVIEW · 2027</small><blockquote>“You can make a great shot against him and still lose the point. That is the part that gets inside your head.”</blockquote><cite>— Carlos Alcaraz</cite></aside></section>
      <section class="archive-section royal-colour-gallery"><figure class="royal-colour-photo"><img src="assets/royal-crowd-web.jpg" decoding="async" alt="A packed tennis crowd in colourful stadium seating."><figcaption>THE WITNESSES · PARIS</figcaption></figure><figure class="royal-colour-photo sunset"><img src="assets/royal-court-sunset.jpg" decoding="async" alt="A blue tennis court under a dramatic sunset."><figcaption>THE COURT AFTER DARK</figcaption></figure><aside class="archive-testimonial testimonial-djokovic"><small>FICTIONAL ARCHIVE INTERVIEW · 2027</small><blockquote>“The crowd can feel when someone owns the moment. Against Basa, the silence before the next point was louder than the stadium.”</blockquote><cite>— Novak Djokovic</cite></aside></section>
      <section class="archive-section archive-records"><h2 class="archive-heading">THE NUMBERS, ENCHANTED</h2><div class="records-layout"><div class="record-strip"><div class="record-stat"><span>2027 SLAMS</span><b>4</b></div><div class="record-stat"><span>SLAM FINALS</span><b>4–0</b></div><div class="record-stat"><span>FINAL SETS LOST</span><b>3</b></div><div class="record-stat"><span>FEDERER HANDSHAKES</span><b>1</b></div><div class="record-stat"><span>AURA</span><b>∞</b></div></div><aside class="h2h"><h3>HEAD-TO-HEAD</h3><ul><li><span>Jannik Sinner</span><b>2–0</b></li><li><span>Carlos Alcaraz</span><b>1–0</b></li><li><span>Novak Djokovic</span><b>1–0</b></li><li class="jayden"><span>Jayden Bone</span><small>6–0  6–0</small><b>1–0</b></li></ul><p>The evidence is golden. The testimony is unanimous.</p></aside></div><aside class="archive-testimonial testimonial-jayden"><small>FICTIONAL ARCHIVE PRACTICE NOTE · JAYDEN BONE</small><blockquote>“Training with Sid is absurd. He can give you a different ball every shot, then act like the whole drill was normal. Five minutes in, you are defending like it is a Slam final. The aura is frankly irresponsible.”</blockquote><cite>— Jayden Bone</cite></aside></section>
      <section class="archive-section archive-armament"><div class="armament"><img class="blade-racket" src="assets/sid-wilson-blade-web.png" decoding="async" alt="Blue and black Wilson Blade tennis racket."><div><h3>ROYAL ARMAMENT</h3><b>Wilson Blade</b><span>Blue / Black</span><span>Status: Wielded</span><p>The mighty weapon. Fast through the air, brutal off the ground, and apparently capable of issuing a royal decree from the baseline.</p></div></div><aside class="archive-testimonial testimonial-federer"><small>FICTIONAL ARCHIVE INTERVIEW · 2027</small><blockquote>“You see the Blade in his hand and think you understand the point. Then he changes the geometry of the court.”</blockquote><cite>— Roger Federer</cite></aside><p class="archive-quote" data-archive-quote>“The racket chose him.” — Royal Archive</p></section>
      <section class="archive-plaque"><p>Every legend needs a closing plaque. This one has a kingdom behind it.</p><img src="assets/sid-honour-plaque-transparent.png" decoding="async" width="2048" height="682" alt="In Honour of Siddharth R. Basa. Champion. Monarch. Wielder of the Blade. The Royal Tennis Archive · Est. 2027."></section></div>
      <div class="archive-lightbox hidden" data-lightbox role="dialog" aria-modal="true" aria-label="Enlarged archive image"><button class="lightbox-nav lightbox-prev" type="button" data-lightbox-prev aria-label="Previous carousel image">‹</button><button type="button" data-lightbox-close aria-label="Close image">×</button><img data-lightbox-image alt=""><button class="lightbox-nav lightbox-next" type="button" data-lightbox-next aria-label="Next carousel image">›</button></div>
      <div class="music-dock" aria-label="Archive music controls"><button class="music-play" type="button" data-music-play aria-label="Play music">▶</button><div class="music-meta"><span class="music-title" data-music-title></span><canvas class="spectrum" data-spectrum width="230" height="36" aria-hidden="true"></canvas></div><div class="music-tools"><button type="button" data-music-swap aria-label="Switch track">↺</button><input class="music-volume" data-music-volume type="range" min="0" max="1" value=".55" step=".01" aria-label="Music volume"><button type="button" data-music-mute aria-label="Mute music">◉</button></div></div><button class="sid-effect-button" type="button" data-sid-effect aria-label="Summon Sid"><span>SUMMON</span><b>SID</b></button>`;
  }
  function renderPortal(){
    if(archive.childElementCount)return;
    archive.innerHTML=portalMarkup();
    archive.querySelector('[data-archive-return]').addEventListener('click',leavePortal);
    archive.querySelector('[data-slide-prev]').addEventListener('click',()=>setSlide(slide-1));
    archive.querySelector('[data-slide-next]').addEventListener('click',()=>setSlide(slide+1));
    archive.querySelectorAll('[data-slide-jump]').forEach(button=>button.addEventListener('click',()=>setSlide(Number(button.dataset.slideJump))));
    const carousel=archive.querySelector('[data-carousel]');
    carousel.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'){event.preventDefault();setSlide(slide-1)}if(event.key==='ArrowRight'){event.preventDefault();setSlide(slide+1)}});
    carousel.addEventListener('touchstart',event=>{touchStart=event.changedTouches[0].clientX},{passive:true});
    carousel.addEventListener('touchend',event=>{const distance=event.changedTouches[0].clientX-touchStart;if(Math.abs(distance)>42)setSlide(slide+(distance<0?1:-1))},{passive:true});
    archive.querySelector('[data-music-play]').addEventListener('click',toggleMusic);
    archive.querySelector('[data-music-swap]').addEventListener('click',swapTrack);
    archive.querySelector('[data-music-volume]').addEventListener('input',event=>{music.volume=Number(event.target.value);music.muted=false;syncMusic();});
    archive.querySelector('[data-music-mute]').addEventListener('click',()=>{music.muted=!music.muted;syncMusic()});
    archive.querySelector('[data-sid-effect]').addEventListener('click',sidEffect);
    archive.querySelectorAll('[data-enlarge-src]').forEach(item=>{const open=()=>{const win=item.closest('[data-win-slide]');openLightbox(item.dataset.enlargeSrc,item.dataset.enlargeAlt,win?Number(win.dataset.winSlide):null)};item.addEventListener('click',open);item.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open()}})});
    archive.querySelector('[data-lightbox-close]').addEventListener('click',closeLightbox);
    archive.querySelector('[data-lightbox-prev]').addEventListener('click',()=>navigateLightbox(-1));
    archive.querySelector('[data-lightbox-next]').addEventListener('click',()=>navigateLightbox(1));
    archive.querySelector('[data-lightbox]').addEventListener('click',event=>{if(event.target===event.currentTarget)closeLightbox()});
    const hero=archive.querySelector('[data-hero]'),heroImage=hero.querySelector('img');
    hero.addEventListener('pointermove',event=>{if(reduced.matches)return;const box=hero.getBoundingClientRect(),x=(event.clientX-box.left)/box.width-.5,y=(event.clientY-box.top)/box.height-.5;heroImage.style.transform=`scale(1.025) translate(${x*6}px,${y*5}px)`});
    hero.addEventListener('pointerleave',()=>{heroImage.style.transform='scale(1.018)'});
    setTrack(0,false);setSlide(0);
  }
  function loadSlide(index){const image=archive.querySelector(`[data-win-slide="${index}"] img`);if(image&&!image.getAttribute('src'))image.src=image.dataset.src;}
  function setSlide(next){slide=(next+wins.length)%wins.length;loadSlide(slide);archive.querySelectorAll('[data-win-slide]').forEach((element,index)=>{const active=index===slide;element.classList.toggle('active',active);element.setAttribute('aria-hidden',String(!active));const image=element.querySelector('img');if(image)image.tabIndex=active?0:-1});archive.querySelectorAll('[data-slide-jump]').forEach(button=>{const current=Number(button.dataset.slideJump)===slide;button.setAttribute('aria-current',String(current))});}
  function setTrack(next,shouldPlay){track=(next+tracks.length)%tracks.length;const wasPlaying=!music.paused;music.src=tracks[track].src;music.load();syncMusic();if(shouldPlay||wasPlaying)playMusic();}
  function ensureAnalyser(){
    const AudioContext=window.AudioContext||window.webkitAudioContext;
    if(!AudioContext)return false;
    try{
      if(!audioContext){audioContext=new AudioContext();sourceNode=audioContext.createMediaElementSource(music);analyser=audioContext.createAnalyser();analyser.fftSize=64;sourceNode.connect(analyser);analyser.connect(audioContext.destination);}
      if(audioContext.state==='suspended')audioContext.resume();
      return true;
    }catch{return false}
  }
  function playMusic(){ensureAnalyser();music.play().then(()=>{syncMusic();drawSpectrum()}).catch(()=>syncMusic())}
  function toggleMusic(){if(music.paused)playMusic();else{music.pause();syncMusic();stopSpectrum()}}
  function swapTrack(){setTrack(track+1,true)}
  function syncMusic(){const play=archive.querySelector('[data-music-play]'),title=archive.querySelector('[data-music-title]'),mute=archive.querySelector('[data-music-mute]'),volume=archive.querySelector('[data-music-volume]');if(!play)return;play.textContent=music.paused?'▶':'Ⅱ';play.setAttribute('aria-label',music.paused?'Play music':'Pause music');title.textContent=tracks[track].title;mute.textContent=music.muted||music.volume===0?'○':'◉';mute.setAttribute('aria-label',music.muted?'Unmute music':'Mute music');volume.value=String(music.volume)}
  function stopSpectrum(){cancelAnimationFrame(animationFrame);animationFrame=0;const canvas=archive.querySelector('[data-spectrum]'),context=canvas?.getContext('2d');if(context&&canvas){context.clearRect(0,0,canvas.width,canvas.height);context.strokeStyle='rgba(235,190,91,.38)';context.beginPath();context.moveTo(0,canvas.height/2);context.lineTo(canvas.width,canvas.height/2);context.stroke();}}
  function drawSpectrum(){if(!portalOpen||music.paused||!analyser){stopSpectrum();return}const canvas=archive.querySelector('[data-spectrum]'),context=canvas?.getContext('2d');if(!canvas||!context)return;const bins=new Uint8Array(analyser.frequencyBinCount);const draw=()=>{if(!portalOpen||music.paused)return stopSpectrum();analyser.getByteFrequencyData(bins);context.clearRect(0,0,canvas.width,canvas.height);const width=canvas.width/bins.length;for(let i=0;i<bins.length;i++){const height=Math.max(2,bins[i]/255*canvas.height);context.fillStyle=`rgba(244,${185+i*2},92,${.34+bins[i]/510})`;context.fillRect(i*width,canvas.height-height,width-1,height)}animationFrame=requestAnimationFrame(draw)};cancelAnimationFrame(animationFrame);draw()}
  function openLightbox(src,alt,winIndex=null){const box=archive.querySelector('[data-lightbox]'),image=archive.querySelector('[data-lightbox-image]');if(!box||!image)return;lightboxSlide=Number.isInteger(winIndex)?winIndex:-1;image.src=src;image.alt=alt||'Enlarged archive image';box.classList.toggle('is-carousel',lightboxSlide>=0);box.classList.remove('hidden');document.body.classList.add('archive-lightbox-open');box.querySelector('[data-lightbox-close]').focus()}
  function navigateLightbox(step){if(lightboxSlide<0)return;lightboxSlide=(lightboxSlide+step+wins.length)%wins.length;const win=wins[lightboxSlide],image=archive.querySelector('[data-lightbox-image]');if(!image)return;image.src=win.src;image.alt=win.alt;setSlide(lightboxSlide)}
  function closeLightbox(){const box=archive.querySelector('[data-lightbox]');if(!box)return;lightboxSlide=-1;box.classList.remove('is-carousel');box.classList.add('hidden');document.body.classList.remove('archive-lightbox-open')}
  function fadeMusic(target,duration,done){clearInterval(fadeTimer);const start=music.volume,steps=Math.max(1,Math.round(duration/45));let tick=0;fadeTimer=setInterval(()=>{tick++;music.volume=start+(target-start)*(tick/steps);syncMusic();if(tick>=steps){clearInterval(fadeTimer);music.volume=target;done?.()}},45)}
  function beginQuotes(){const quote=archive.querySelector('[data-archive-quote]'),quotes=['“The racket chose him.” — Royal Archive','“Four majors. One year. Suspicious.” — Statistical Department','“The throne did not make the champion. It merely fitted.” — Court Historian','“He made the draw look ceremonial.” — Archive Clerk','“Every point was a coronation rehearsal.” — The North Stand'];let index=0;clearInterval(quoteTimer);quoteTimer=setInterval(()=>{if(!portalOpen||!quote)return;quote.classList.add('fading');setTimeout(()=>{index=(index+1)%quotes.length;quote.textContent=quotes[index];quote.classList.remove('fading')},220)},5200)}
  function showIntro(){const intro=archive.querySelector('.archive-intro');if(sessionStorage.getItem(INTRO_KEY)==='1'||reduced.matches){intro.hidden=true;return}intro.hidden=false;setTimeout(()=>{intro.querySelector('p').textContent='SIDDHARTH R. BASA'},560);setTimeout(()=>{intro.classList.add('leaving');sessionStorage.setItem(INTRO_KEY,'1');setTimeout(()=>{intro.hidden=true;intro.classList.remove('leaving')},470)},1350)}
  function enterPortal(){if(!unlocked())return;returnFocus=document.activeElement;preloadArchiveMedia();playMusic();transition(activatePortal,{title:'THE GLORIOUS SID BASA PORTAL',message:'Summoning the Royal Archive…',variant:'royal'})}
  function activatePortal(){if(!unlocked())return;preloadArchiveMedia();renderPortal();portalOpen=true;document.body.classList.add('portal-active');archive.classList.remove('hidden');archive.setAttribute('aria-hidden','false');document.title='Royal Tennis Archive';showIntro();beginQuotes();syncMusic();if(!music.paused)drawSpectrum();setTimeout(()=>archive.querySelector('[data-archive-return]')?.focus(),0)}
  function leavePortal(){if(!portalOpen)return;closeLightbox();transition(()=>{portalOpen=false;music.pause();stopSpectrum();clearInterval(quoteTimer);document.body.classList.remove('portal-active');archive.classList.add('hidden');archive.setAttribute('aria-hidden','true');document.title='BRTA Power Ratings';returnFocus?.focus?.()},{title:'Returning to ratings',message:'Restoring BRTA Power Ratings…'})}
  function sidEffect(){
    if(sidBusy||!portalOpen)return;
    sidBusy=true;
    const restoreVolume=music.volume,wasPlaying=!music.paused;
    fadeMusic(0,520,()=>{
      if(wasPlaying)music.pause();
      setTimeout(()=>{
        const stage=document.createElement('div');
        stage.className='sid-rise-stage';
        stage.setAttribute('aria-hidden','true');
        const palette=['#fff7d2','#f4c650','#bc7827','#5f99ff','#f15b65','#75d3c8','#ffe9a1'];
        for(let i=0;i<260;i++){
          const piece=document.createElement('i'),leftSide=i%2===0,edge=leftSide?Math.round(2+Math.random()*7):Math.round(91+Math.random()*7),outward=leftSide?-1:1;
          piece.className='royal-confetti';
          piece.style.setProperty('--origin-x',`${edge}vw`);
          piece.style.setProperty('--origin-y',`${Math.round(66+Math.random()*29)}vh`);
          piece.style.setProperty('--x',`${outward*Math.round(18+Math.random()*105)}px`);
          piece.style.setProperty('--y',`${Math.round(-innerHeight*(.32+Math.random()*.72))}px`);
          piece.style.setProperty('--r',`${Math.round((Math.random()-.5)*1280)}deg`);
          piece.style.setProperty('--delay',`${Math.random()*.52}s`);
          piece.style.setProperty('--confetti-color',palette[i%palette.length]);
          stage.appendChild(piece);
        }
        const figure=document.createElement('img');
        figure.className='sid-rise-figure';
        figure.src='assets/sid-royal-rise-transparent.png';
        figure.alt='';
        stage.appendChild(figure);
        const beginArrival=()=>{
          if(!portalOpen){sidBusy=false;return}
          document.body.appendChild(stage);
          playRoyalGong();
          if(!reduced.matches)stage.classList.add('royal-shake');
          setTimeout(()=>stage.classList.remove('royal-shake'),reduced.matches?0:3300);
          const stay=reduced.matches?1200:8500;
          setTimeout(()=>{
            if(wasPlaying){music.volume=0;playMusic();fadeMusic(restoreVolume,2400)}
          },stay);
          setTimeout(()=>{stage.remove();sidBusy=false},stay+(reduced.matches?450:1850));
        };
        if(typeof figure.decode==='function')figure.decode().then(beginArrival,beginArrival);
        else if(figure.complete)beginArrival();
        else{figure.addEventListener('load',beginArrival,{once:true});figure.addEventListener('error',beginArrival,{once:true})}
      },780);
    });
  }
  window.AuxiliaryPortal={bindSettings,open:enterPortal,isUnlocked:unlocked,locked:()=>!unlocked()};
  updateEntry();bindSettings();
  if(unlocked())queueMicrotask(()=>window.dispatchEvent(new Event('brta-module-toggle')));
})();
