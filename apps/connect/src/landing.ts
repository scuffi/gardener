export function landingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#f6f7f8">
  <script>
    (()=>{try{const preference=localStorage.getItem('gardener.theme')||'system';const mode=preference==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):preference;document.documentElement.dataset.mode=mode;document.documentElement.dataset.themePreference=preference;document.querySelector('meta[name="theme-color"]').content=mode==='dark'?'#0d0f12':'#f6f7f8'}catch{}})();
  </script>
  <meta name="description" content="Deploy policy-controlled repository automation to your Cloudflare account.">
  <title>Gardener — Repository automation on Cloudflare</title>
  <style>
    :root{color-scheme:light;--canvas:#f6f7f8;--surface:#fff;--raised:#fafbfc;--recessed:#f1f3f5;--text:#1d2026;--strong:#111318;--muted:#606772;--subtle:#626b76;--line:#e1e4e8;--line-strong:#ced3da;--blue:#2864dc;--blue-hover:#1f52bd;--blue-tint:#eef4ff;--on-blue:#fff;--green:#17804c;--green-strong:#12663d;--green-tint:#edf8f2;--orange:#f48120;--danger:#c92d38;--danger-tint:#fff2f3;--radius:10px;--shadow:0 20px 50px rgba(15,23,42,.1);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text);background:var(--canvas);font-synthesis:none}
    :root[data-mode="dark"]{color-scheme:dark;--canvas:#0d0f12;--surface:#15181d;--raised:#191d23;--recessed:#101216;--text:#e9ecf1;--strong:#f8fafc;--muted:#aab1bc;--subtle:#858e9b;--line:#272c34;--line-strong:#39414c;--blue:#75a2ff;--blue-hover:#96b8ff;--blue-tint:#18243a;--on-blue:#0a1428;--green:#55be83;--green-strong:#72d69a;--green-tint:#14271d;--orange:#f39a4a;--danger:#ff7b83;--danger-tint:#2b171a;--shadow:0 24px 60px rgba(0,0,0,.3)}
    *{box-sizing:border-box}html{min-width:320px}body{min-width:320px;min-height:100vh;margin:0;background:var(--canvas)}button,a{font:inherit;-webkit-tap-highlight-color:transparent}button:focus-visible,a:focus-visible{outline:2px solid var(--blue);outline-offset:3px}.shell{width:min(1160px,calc(100% - 48px));margin:0 auto}.topbar{height:64px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.top-actions{display:flex;align-items:center;gap:12px}.brand{display:flex;align-items:center;gap:10px;color:var(--strong);text-decoration:none}.mark{width:32px;height:32px;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--green) 25%,var(--line));border-radius:9px;color:var(--green-strong);background:var(--green-tint)}.mark svg{width:19px;height:19px}.brand-copy{display:grid;line-height:1.2}.brand-copy strong{font-size:14px;font-weight:650}.brand-copy span{color:var(--subtle);font-size:11px}.cloudflare-context{display:flex;align-items:center;gap:7px;color:var(--subtle);font-size:12px}.cloudflare-context i{width:7px;height:7px;border-radius:50%;background:var(--orange)}.theme-toggle{width:34px;height:34px;display:grid;place-items:center;border:1px solid var(--line);border-radius:8px;color:var(--muted);background:color-mix(in srgb,var(--surface) 86%,transparent);cursor:pointer}.theme-toggle:hover{color:var(--strong);border-color:var(--line-strong);background:var(--recessed)}.theme-toggle svg{width:17px;height:17px}.theme-toggle .theme-sun{display:none}:root[data-mode="dark"] .theme-toggle .theme-sun{display:block}:root[data-mode="dark"] .theme-toggle .theme-moon{display:none}main{min-height:calc(100vh - 64px);display:grid;grid-template-columns:minmax(0,1.08fr) minmax(390px,.92fr);align-items:center;gap:64px;padding:64px 0 84px}.eyebrow{margin:0 0 12px;color:var(--green-strong);font-size:12px;font-weight:650;letter-spacing:.05em;text-transform:uppercase}.intro h1{max-width:690px;margin:0;color:var(--strong);font-size:clamp(42px,5.2vw,64px);font-weight:650;line-height:1.03;letter-spacing:-.045em}.lead{max-width:620px;margin:24px 0 0;color:var(--muted);font-size:17px;line-height:1.6}.platform{display:flex;flex-wrap:wrap;gap:8px;margin-top:28px}.platform span{padding:6px 9px;border:1px solid var(--line);border-radius:7px;color:var(--muted);background:var(--surface);font-size:12px}.architecture-note{max-width:610px;display:flex;gap:10px;margin-top:20px;color:var(--subtle);font-size:12px}.architecture-note svg{flex:none;color:var(--green);margin-top:1px}.card{position:relative;overflow:hidden;border:1px solid var(--line-strong);border-radius:12px;background:var(--surface);box-shadow:var(--shadow)}.card:before{content:"";position:absolute;inset:0 0 auto;height:3px;background:var(--orange)}.card-body{padding:28px}.step-label{display:flex;align-items:center;justify-content:space-between;gap:16px;color:var(--subtle);font-size:11px}.step-label strong{color:var(--green-strong);font-weight:650}.card h2{margin:14px 0 7px;color:var(--strong);font-size:22px;font-weight:650;line-height:1.25;letter-spacing:-.02em}.card-copy{margin:0;color:var(--muted);font-size:13px;line-height:1.55}.steps{position:relative;display:grid;margin:24px 0;border-top:1px solid var(--line)}.steps:before{position:absolute;top:25px;bottom:25px;left:11px;width:1px;content:"";background:var(--line-strong)}.step{position:relative;display:grid;grid-template-columns:28px minmax(0,1fr);gap:10px;padding:13px 0;border-bottom:1px solid var(--line)}.step-number{position:relative;z-index:1;width:24px;height:24px;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--blue) 28%,var(--line));border-radius:50%;color:var(--blue);background:var(--blue-tint);font-size:11px;font-weight:650}.step strong{display:block;color:var(--text);font-size:13px;font-weight:600}.step p{margin:2px 0 0;color:var(--subtle);font-size:11px}.button,button.primary{min-height:40px;display:inline-flex;align-items:center;justify-content:center;gap:7px;width:100%;border:1px solid var(--blue);border-radius:8px;padding:9px 14px;color:var(--on-blue);background:var(--blue);font-weight:600;text-align:center;text-decoration:none;cursor:pointer}.button:hover,button.primary:hover{border-color:var(--blue-hover);background:var(--blue-hover)}button:disabled{cursor:wait;opacity:.65}.fine{margin:12px 0 0;color:var(--subtle);font-size:11px;text-align:center}.hidden{display:none!important}.success{width:42px;height:42px;display:grid;place-items:center;margin-bottom:16px;border:1px solid color-mix(in srgb,var(--green) 25%,var(--line));border-radius:50%;color:var(--green-strong);background:var(--green-tint)}.success svg{width:21px;height:21px}.token-label{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:20px 0 7px;color:var(--muted);font-size:11px;font-weight:600}.copy{min-height:30px;border:1px solid var(--line-strong);border-radius:7px;padding:5px 9px;color:var(--text);background:var(--surface);font-size:11px;font-weight:550;cursor:pointer}.copy:hover{background:var(--recessed)}.token{display:block;max-height:104px;overflow:auto;overflow-wrap:anywhere;padding:13px;border:1px solid var(--line);border-radius:8px;color:var(--text);background:var(--recessed);font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}.handoff-note{display:flex;align-items:flex-start;gap:9px;margin:15px 0;color:var(--muted);font-size:11px}.handoff-dot{width:7px;height:7px;flex:none;margin-top:5px;border-radius:50%;background:var(--orange)}.error{margin-top:13px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--danger) 30%,var(--line));border-radius:8px;color:var(--danger);background:var(--danger-tint);font-size:12px}.result-actions{display:grid;gap:8px;margin-top:18px}
    @media(max-width:900px){main{grid-template-columns:1fr;gap:38px;padding:46px 0 64px}.intro{max-width:720px}.card{width:min(560px,100%)}}
    @media(max-width:560px){.shell{width:min(100% - 28px,1160px)}.cloudflare-context span{display:none}main{padding:32px 0 44px}.intro h1{font-size:40px}.lead{margin-top:18px;font-size:15px}.platform{margin-top:22px}.card-body{padding:22px}.step-label{align-items:flex-start;flex-direction:column;gap:2px}}
    @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="Gardener home"><span class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 21v-9m0 4c-4 0-7-2.5-7-6 4 0 7 2.5 7 6Zm0-4c0-4.2 2.8-7 7-7 0 4.2-2.8 7-7 7Z"/></svg></span><span class="brand-copy"><strong>Gardener</strong><span>Repository automation</span></span></a>
      <div class="top-actions"><div class="cloudflare-context"><i aria-hidden="true"></i><span>Deployed to your Cloudflare account</span></div><button id="theme" class="theme-toggle" type="button" aria-label="Switch to dark theme" title="Change color theme"><svg class="theme-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20.2 15.2A8.3 8.3 0 0 1 8.8 3.8 8.5 8.5 0 1 0 20.2 15.2Z"/></svg><svg class="theme-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button></div>
    </header>
    <main>
      <section class="intro" aria-labelledby="intro-title">
        <p class="eyebrow">Customer-owned repository automation</p>
        <h1 id="intro-title">Repository automation, deployed to your Cloudflare account.</h1>
        <p class="lead">Classify issues and propose policy-controlled GitHub actions from a Worker you own. Runtime data, workflow state, and Workers AI execution stay in your account.</p>
        <div class="platform" aria-label="Cloudflare services used"><span>Workers</span><span>D1</span><span>Cloudflare Queues</span><span>Workers AI</span></div>
        <div class="architecture-note"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg><span>GitHub credentials remain isolated in Gardener Connect and are never exposed to your Worker or an AI model.</span></div>
      </section>

      <section id="start-card" class="card" aria-labelledby="start-title">
        <div class="card-body">
          <div class="step-label"><strong>Three-step setup</strong><span>No local CLI required</span></div>
          <h2 id="start-title">Deploy Gardener</h2>
          <p class="card-copy">Confirm your GitHub identity, create a Gardener instance credential, then let Cloudflare provision the application resources.</p>
          <div class="steps">
            <div class="step"><span class="step-number">1</span><div><strong>Confirm with GitHub</strong><p>Bind the instance credential to your identity.</p></div></div>
            <div class="step"><span class="step-number">2</span><div><strong>Deploy to Cloudflare</strong><p>Paste one secret; Cloudflare provisions the Worker and bindings.</p></div></div>
            <div class="step"><span class="step-number">3</span><div><strong>Select repositories and permissions</strong><p>Choose access and start with a safe policy preset.</p></div></div>
          </div>
          <button id="start" class="primary">Continue to GitHub</button>
          <p class="fine">Authorization is temporary and scoped to this setup flow.</p>
          <div id="error" class="error hidden" role="alert"></div>
        </div>
      </section>

      <section id="result" class="card hidden" aria-labelledby="result-title" tabindex="-1">
        <div class="card-body">
          <div class="success" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m5 12 4 4L19 6"/></svg></div>
          <div class="step-label"><strong>Instance credential created</strong><span>Step 2 of 3</span></div>
          <h2 id="result-title">Continue to Cloudflare</h2>
          <p class="card-copy">Copy this credential when Cloudflare asks for <code>GARDENER_INSTANCE_TOKEN</code>. Gardener uses it for ongoing server-to-server authentication; Connect stores only its hash.</p>
          <div class="token-label"><span>GARDENER_INSTANCE_TOKEN</span><button id="copy" class="copy" type="button" aria-live="polite">Copy token</button></div>
          <code id="token" class="token"></code>
          <div class="handoff-note"><span class="handoff-dot" aria-hidden="true"></span><span>Keep this tab open until deployment finishes. This token is displayed only once.</span></div>
          <div class="result-actions"><a id="deploy" class="button" target="_blank" rel="noopener noreferrer">Copy token and deploy to Cloudflare</a></div>
          <p class="fine">After deployment, open the Worker URL and complete repository setup.</p>
          <div id="result-error" class="error hidden" role="alert"></div>
        </div>
      </section>
    </main>
  </div>
  <script>
    const start=document.querySelector('#start'),startCard=document.querySelector('#start-card'),result=document.querySelector('#result'),token=document.querySelector('#token'),deploy=document.querySelector('#deploy'),copy=document.querySelector('#copy'),theme=document.querySelector('#theme');
    function updateThemeUi(mode){document.querySelector('meta[name="theme-color"]').content=mode==='dark'?'#0d0f12':'#f6f7f8';theme.setAttribute('aria-label',mode==='dark'?'Switch to light theme':'Switch to dark theme')}
    function setTheme(mode){document.documentElement.dataset.mode=mode;document.documentElement.dataset.themePreference=mode;try{localStorage.setItem('gardener.theme',mode)}catch{}updateThemeUi(mode)}
    function showError(message,target='#error'){const node=document.querySelector(target);node.textContent=message;node.classList.remove('hidden');node.focus?.()}
    async function copyToken(){const value=token.textContent;try{await navigator.clipboard.writeText(value)}catch{const area=document.createElement('textarea');area.value=value;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();document.execCommand('copy');area.remove()}copy.textContent='Copied';setTimeout(()=>copy.textContent='Copy token',1800)}
    async function createDeployment(){start.disabled=true;start.textContent='Preparing deployment…';document.querySelector('#error').classList.add('hidden');try{const response=await fetch('/v1/bootstrap',{method:'POST'});const body=await response.json();if(response.status===401){location.href='/v1/landing/start';return}if(!response.ok)throw new Error(body.error||'The deployment token could not be created. Try again.');token.textContent=body.token;deploy.href=body.deployUrl;startCard.classList.add('hidden');result.classList.remove('hidden');history.replaceState(null,'','/');result.focus()}catch(error){start.disabled=false;start.textContent='Try again';showError(error.message)} }
    start.addEventListener('click',createDeployment);copy.addEventListener('click',copyToken);deploy.addEventListener('click',copyToken);theme.addEventListener('click',()=>setTheme(document.documentElement.dataset.mode==='dark'?'light':'dark'));updateThemeUi(document.documentElement.dataset.mode||'light');if(new URLSearchParams(location.search).get('create')==='1')createDeployment();
  </script>
</body>
</html>`;
}
