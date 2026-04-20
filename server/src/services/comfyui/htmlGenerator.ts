// Served by proxy.service.ts when ComfyUI's backend is unreachable. English
// only (launcher carried a Chinese version); admin domain redirect button is
// rendered only when DOMAIN_COMFYUI_FOR_ADMIN + DOMAIN_LAUNCHER_FOR_ADMIN are
// configured, matching launcher behaviour.

import { env } from '../../config/env.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function getNotRunningHtml(): string {
  const adminComfyDomain = escapeHtml(env.DOMAIN_COMFYUI_FOR_ADMIN);
  const adminLauncherDomain = escapeHtml(env.DOMAIN_LAUNCHER_FOR_ADMIN);
  return `<!DOCTYPE html>
<html>
<head>
<title>ComfyUI Unavailable</title>
<meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; background:white; }
  .container { text-align:center; padding:2rem; max-width:500px; }
  h1 { color:#333; font-size:24px; margin-bottom:10px; }
  p { margin:8px 0 20px; color:#666; font-size:14px; }
  button { border:none; padding:8px 30px; border-radius:8px; cursor:pointer; font-size:16px; font-weight:500; color:white; }
  .retry-btn { background:#4a76fd; }
  .retry-btn:hover { background:#3a66ed; }
  .launcher-btn { background:#28a745; margin-left:10px; }
  .launcher-btn:hover { background:#218838; }
</style>
</head>
<body>
<div class="container">
  <h1>ComfyUI Unavailable</h1>
  <p>The ComfyUI service is currently not running or inaccessible.</p>
  <div id="buttons"></div>
</div>
<script>
(function(){
  var ADMIN_COMFY = ${JSON.stringify(env.DOMAIN_COMFYUI_FOR_ADMIN)};
  var ADMIN_LAUNCHER = ${JSON.stringify(env.DOMAIN_LAUNCHER_FOR_ADMIN)};
  var container = document.getElementById('buttons');
  var host = window.location.hostname;
  var showLauncher = ADMIN_COMFY && host === ADMIN_COMFY && ADMIN_LAUNCHER;
  if (showLauncher) {
    var b = document.createElement('button');
    b.className = 'launcher-btn';
    b.textContent = 'ComfyUI Launcher';
    b.onclick = function(){
      var url = ADMIN_LAUNCHER.indexOf('http') === 0 ? ADMIN_LAUNCHER : 'https://' + ADMIN_LAUNCHER;
      window.location.href = url;
    };
    container.appendChild(b);
  } else {
    var r = document.createElement('button');
    r.className = 'retry-btn';
    r.textContent = 'Retry';
    r.onclick = function(){ window.location.reload(); };
    container.appendChild(r);
  }
  // Reference config vars so linters see them in use when inlined.
  void adminRefs();
  function adminRefs(){ return [${JSON.stringify(adminComfyDomain)}, ${JSON.stringify(adminLauncherDomain)}].length; }
})();
</script>
</body>
</html>`;
}
