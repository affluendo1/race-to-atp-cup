(()=>{
  const $=selector=>document.querySelector(selector);
  const overlay=$("#installOverlay"),button=$("#installBtn"),guide=$("#installGuide"),nativeButton=$("#nativeInstallBtn");
  if(!overlay||!button||!guide||!nativeButton)return;
  let deferredPrompt=null,returnFocus=null;
  const standalone=()=>Boolean(window.navigator.standalone||window.matchMedia("(display-mode: standalone)").matches);
  const ios=()=>/iphone|ipad|ipod/i.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
  const setInstalled=()=>{
    button.classList.add("hidden");
    if(!overlay.classList.contains("hidden"))closeGuide();
  };
  const openGuide=()=>{
    if(standalone())return;
    returnFocus=document.activeElement;
    const isApple=ios();
    guide.innerHTML=isApple
      ?"<b>On iPhone or iPad</b><ol><li>Open this page in Safari.</li><li>Tap the Share button in the browser toolbar.</li><li>Choose <b>Add to Home Screen</b>, then tap <b>Add</b>.</li></ol>"
      :"<b>On a computer</b><ol><li>Open this site in Chrome or Edge.</li><li>Use the install icon in the address bar, or open the browser menu.</li><li>Choose <b>Install BRTA Power Ratings</b>.</li></ol>";
    nativeButton.classList.toggle("hidden",!deferredPrompt);
    overlay.classList.remove("hidden");
    document.body.classList.add("modal-open");
    $("#installClose").focus();
  };
  const closeGuide=()=>{
    overlay.classList.add("hidden");
    if(!document.querySelector(".overlay:not(.hidden)"))document.body.classList.remove("modal-open");
    if(returnFocus&&typeof returnFocus.focus==="function")returnFocus.focus();
  };
  button.addEventListener("click",openGuide);
  $("#installClose").addEventListener("click",closeGuide);
  $("#installDoneBtn").addEventListener("click",closeGuide);
  overlay.addEventListener("click",event=>{if(event.target.dataset.installClose)closeGuide()});
  document.addEventListener("keydown",event=>{if(event.key==="Escape"&&!overlay.classList.contains("hidden"))closeGuide()});
  window.addEventListener("beforeinstallprompt",event=>{
    event.preventDefault();
    deferredPrompt=event;
    if(!overlay.classList.contains("hidden"))nativeButton.classList.remove("hidden");
  });
  nativeButton.addEventListener("click",async()=>{
    if(!deferredPrompt)return;
    const prompt=deferredPrompt;
    deferredPrompt=null;
    nativeButton.classList.add("hidden");
    await prompt.prompt();
    const result=await prompt.userChoice;
    if(result?.outcome==="accepted")closeGuide();
  });
  window.addEventListener("appinstalled",setInstalled);
  if(standalone())setInstalled();
  window.addEventListener("online",()=>document.body.classList.remove("is-offline"));
  window.addEventListener("offline",()=>document.body.classList.add("is-offline"));
  if(!navigator.onLine)document.body.classList.add("is-offline");
  if("serviceWorker" in navigator){
    window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js",{scope:"./"}).catch(()=>{}),{once:true});
  }
})();
