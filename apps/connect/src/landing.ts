export function landingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Gardener — Your repository, always tended</title>
  <style>
    :root{--ink:#07100a;--bg:#09100b;--panel:#101a13;--panel2:#152219;--line:#26352a;--text:#f1f7f1;--muted:#9cab9e;--leaf:#a4f783;--leaf2:#5fce76;--amber:#f4ce78;font:16px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text);background:var(--bg)}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 75% 10%,rgba(62,124,75,.23),transparent 28%),radial-gradient(circle at 15% 85%,rgba(44,91,57,.14),transparent 26%),var(--bg)}
    body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.18;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.06'/%3E%3C/svg%3E")}
    .shell{width:min(1180px,calc(100% - 40px));margin:auto}.nav{height:86px;display:flex;align-items:center;justify-content:space-between}.brand{display:flex;align-items:center;gap:11px;font-size:18px;font-weight:760;letter-spacing:-.02em}.mark{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;color:#071109;background:linear-gradient(145deg,var(--leaf),var(--leaf2));font:900 19px Georgia,serif;box-shadow:0 8px 30px rgba(100,218,119,.18)}
    .managed{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px}.pulse{width:7px;height:7px;border-radius:50%;background:var(--leaf);box-shadow:0 0 12px var(--leaf)}
    main{min-height:calc(100vh - 126px);display:grid;grid-template-columns:minmax(0,1.08fr) minmax(400px,.92fr);gap:52px;align-items:center;padding:36px 0 80px}.eyebrow{margin:0 0 18px;color:var(--leaf);font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}.intro h1{max-width:680px;margin:0;font-size:clamp(50px,6.2vw,82px);line-height:.98;letter-spacing:-.065em}.intro h1 em{color:var(--leaf);font:inherit;font-style:normal}.lead{max-width:610px;margin:28px 0 0;color:#b5c1b7;font-size:19px;line-height:1.65}.trust{display:flex;gap:22px;flex-wrap:wrap;margin-top:34px;color:var(--muted);font-size:13px}.trust span:before{content:"✓";margin-right:8px;color:var(--leaf);font-weight:900}
    .card{position:relative;padding:30px;border:1px solid var(--line);border-radius:24px;background:linear-gradient(160deg,rgba(21,34,25,.97),rgba(13,22,16,.97));box-shadow:0 28px 90px rgba(0,0,0,.34);overflow:hidden}.card:before{content:"";position:absolute;width:170px;height:170px;border-radius:50%;right:-90px;top:-100px;background:var(--leaf);filter:blur(80px);opacity:.13}.step-label{display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:12px}.step-label strong{color:var(--leaf);font-weight:750}.card h2{margin:16px 0 10px;font-size:29px;line-height:1.16;letter-spacing:-.035em}.card-copy{margin:0 0 24px;color:var(--muted)}
    .steps{display:grid;gap:0;margin:8px 0 28px}.step{display:grid;grid-template-columns:32px 1fr;gap:12px;min-height:66px}.step-dot{position:relative;width:28px;height:28px;border:1px solid #405246;border-radius:50%;display:grid;place-items:center;color:var(--leaf);font-size:12px;font-weight:800;background:#122018}.step:not(:last-child) .step-dot:after{content:"";position:absolute;top:28px;left:13px;width:1px;height:38px;background:var(--line)}.step strong{display:block;font-size:14px}.step p{margin:2px 0 0;color:var(--muted);font-size:12px}
    button,.button{width:100%;border:0;border-radius:12px;padding:13px 17px;background:linear-gradient(135deg,var(--leaf),#75df84);color:var(--ink);font:inherit;font-weight:800;text-decoration:none;text-align:center;cursor:pointer;box-shadow:0 10px 28px rgba(117,223,132,.12);transition:transform .16s ease,filter .16s ease}button:hover,.button:hover{transform:translateY(-1px);filter:brightness(1.04)}button:disabled{opacity:.6;cursor:wait;transform:none}.fine{margin:14px 0 0;text-align:center;color:#718075;font-size:11px}.hidden{display:none!important}
    .success{width:46px;height:46px;border-radius:15px;display:grid;place-items:center;background:#1c3823;color:var(--leaf);font-size:23px;margin-bottom:17px}.token-label{display:flex;justify-content:space-between;align-items:center;margin:20px 0 8px;color:var(--muted);font-size:12px}.copy{width:auto;padding:5px 9px;border:1px solid var(--line);border-radius:8px;color:var(--text);background:var(--panel2);box-shadow:none;font-size:11px}.token{display:block;max-height:94px;overflow:auto;overflow-wrap:anywhere;padding:15px;border:1px solid #2b3d30;border-radius:11px;background:#080d09;color:#cdf8ce;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.handoff-note{display:flex;gap:10px;margin:18px 0;color:var(--muted);font-size:12px}.handoff-note span{color:var(--amber)}.error{margin-top:14px;padding:11px 13px;border:1px solid #693c38;border-radius:10px;color:#ffaaa4;background:#251615;font-size:12px}
    @media(max-width:860px){main{grid-template-columns:1fr;gap:38px;padding-top:34px}.intro{text-align:center}.intro h1,.lead{margin-left:auto;margin-right:auto}.trust{justify-content:center}.card{width:min(520px,100%);margin:auto}}@media(max-width:520px){.shell{width:min(100% - 24px,1180px)}.nav{height:72px}.managed{display:none}main{padding:26px 0 46px}.intro h1{font-size:46px}.lead{font-size:16px;margin-top:20px}.trust{gap:10px 15px;margin-top:24px}.card{padding:23px;border-radius:19px}}
  </style>
</head>
<body>
  <div class="shell">
    <header class="nav"><div class="brand"><span class="mark">G</span>Gardener</div><div class="managed"><span class="pulse"></span>Managed connection, private deployment</div></header>
    <main>
      <section class="intro">
        <p class="eyebrow">Cloudflare repository maintenance</p>
        <h1>Your repository,<br><em>always tended.</em></h1>
        <p class="lead">Deploy a focused AI gardener into your own Cloudflare account. It classifies issues, proposes useful replies, and stays behind policies you control.</p>
        <div class="trust"><span>One-click Cloudflare deploy</span><span>GitHub keys stay managed</span><span>Paused by default</span></div>
      </section>
      <section id="start-card" class="card">
        <div class="step-label"><strong>Three-minute setup</strong><span>Nothing to install locally</span></div>
        <h2>Grow your first Gardener</h2>
        <p class="card-copy">We create a private connection token, then Cloudflare provisions the Worker, database, queue, and AI binding.</p>
        <div class="steps">
          <div class="step"><span class="step-dot">1</span><div><strong>Confirm with GitHub</strong><p>Securely bind this deployment to you.</p></div></div>
          <div class="step"><span class="step-dot">2</span><div><strong>Deploy to your account</strong><p>Paste one secret; Cloudflare creates everything else.</p></div></div>
          <div class="step"><span class="step-dot">3</span><div><strong>Configure Gardener</strong><p>Pick repositories and a safe automation profile.</p></div></div>
        </div>
        <button id="start">Continue with GitHub</button>
        <p class="fine">Gardener never sends GitHub credentials to your Worker or to AI models.</p>
        <div id="error" class="error hidden" role="alert"></div>
      </section>
      <section id="result" class="card hidden">
        <div class="success">✓</div>
        <div class="step-label"><strong>Connection ready</strong><span>Step 2 of 3</span></div>
        <h2>Hand off to Cloudflare</h2>
        <p class="card-copy">Your one-time token is ready. Copy it when prompted; Cloudflare will provision every other resource automatically.</p>
        <div class="token-label"><span>GARDENER_INSTANCE_TOKEN</span><button id="copy" class="copy">Copy token</button></div>
        <code id="token" class="token"></code>
        <div class="handoff-note"><span>●</span><div>Keep this tab open until deployment finishes. The token is shown once and is not stored in plaintext by Connect.</div></div>
        <a id="deploy" class="button" target="_blank" rel="noopener">Copy token & deploy to Cloudflare ↗</a>
        <p class="fine">After deployment, open your Worker and select “Configure Gardener.”</p>
        <div id="result-error" class="error hidden" role="alert"></div>
      </section>
    </main>
  </div>
  <script>
    const start=document.querySelector('#start'),startCard=document.querySelector('#start-card'),result=document.querySelector('#result'),token=document.querySelector('#token'),deploy=document.querySelector('#deploy');
    function showError(message,target='#error'){const node=document.querySelector(target);node.textContent=message;node.classList.remove('hidden')}
    function copyToken(){const value=token.textContent;const area=document.createElement('textarea');area.value=value;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();document.execCommand('copy');area.remove();if(navigator.clipboard?.writeText)navigator.clipboard.writeText(value).catch(()=>{});document.querySelector('#copy').textContent='Copied';setTimeout(()=>document.querySelector('#copy').textContent='Copy token',1800)}
    async function createDeployment(){start.disabled=true;start.textContent='Preparing your deployment…';try{const response=await fetch('/v1/bootstrap',{method:'POST'});const body=await response.json();if(response.status===401){location.href='/v1/landing/start';return}if(!response.ok)throw new Error(body.error||'Unable to prepare deployment');token.textContent=body.token;deploy.href=body.deployUrl;startCard.classList.add('hidden');result.classList.remove('hidden');history.replaceState(null,'','/')}catch(error){start.disabled=false;start.textContent='Try again';showError(error.message)}}
    start.addEventListener('click',createDeployment);document.querySelector('#copy').addEventListener('click',copyToken);deploy.addEventListener('click',copyToken);
    if(new URLSearchParams(location.search).get('create')==='1')createDeployment();
  </script>
</body>
</html>`;
}
