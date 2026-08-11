"""
英语学习工具 - 完整版（修复词库问题）
======================================
用法：python start.py
"""

import json, sqlite3, webbrowser, os, ssl, zipfile
from pathlib import Path

BASE_DIR = Path(__file__).parent
OUTPUT_DIR = BASE_DIR / "vocabulary_data"
OUTPUT_DIR.mkdir(exist_ok=True)
TEMP_DIR = OUTPUT_DIR / "temp"
TEMP_DIR.mkdir(exist_ok=True)

STAGES = {
    "初中课标词": "tag LIKE '%zk%' OR tag LIKE '%中考%'",
    "高中课标词": "tag LIKE '%gk%' OR tag LIKE '%高考%'",
    "高中进阶词": "tag LIKE '%gk%' OR collins >= 3",
    "四级词汇": "tag LIKE '%cet4%' OR tag LIKE '%四级%'",
    "六级词汇": "tag LIKE '%cet6%' OR tag LIKE '%六级%'",
    "考研词汇": "tag LIKE '%ky%' OR tag LIKE '%考研%'",
    "雅思词汇": "tag LIKE '%ielts%' OR tag LIKE '%雅思%'",
    "托福词汇": "tag LIKE '%toefl%' OR tag LIKE '%托福%'",
    "GRE词汇": "tag LIKE '%gre%'",
    "牛津3000核心": "oxford = 1 OR oxford = '1'",
}

def extract_from_ecdic():
    db_path = OUTPUT_DIR / "ecdict.db"

    if db_path.exists():
        size_mb = db_path.stat().st_size / 1024 / 1024
        print(f"📂 ecdict.db 已存在 ({size_mb:.0f}MB)，跳过下载")
    else:
        print("=" * 50)
        print("⬇️  正在下载 ECDICT 词典数据库（约 200MB）")
        print("   如果下载太慢，可以手动下载放到 vocabulary_data/ 文件夹")
        print("   下载地址：https://github.com/skywind3000/ECDICT/releases/download/1.0.28/ecdict-sqlite-28.zip")
        print("=" * 50)

        ssl._create_default_https_context = ssl._create_unverified_context
        url = "https://github.com/skywind3000/ECDICT/releases/download/1.0.28/ecdict-sqlite-28.zip"
        zip_path = TEMP_DIR / "ecdict.zip"

        try:
            import urllib.request
            print("   下载中...")
            urllib.request.urlretrieve(url, str(zip_path))
            print("   📦 解压中...")
            with zipfile.ZipFile(zip_path, 'r') as zf:
                zf.extract('ecdict.db', str(OUTPUT_DIR))
            print("   ✅ 下载完成")
        except Exception as e:
            print(f"   ❌ 自动下载失败：{e}")
            print(f"   请手动下载后解压 ecdict.db 到 {OUTPUT_DIR}")
            return None

    print("\n📖 正在提取词汇...")
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()

    result = {}
    for stage_name, where in STAGES.items():
        try:
            cursor.execute(f"SELECT DISTINCT word, phonetic, definition, translation, pos FROM stardict WHERE {where} ORDER BY collins DESC LIMIT 6000")
            rows = cursor.fetchall()
            words = []
            for word, phonetic, definition, translation, pos in rows:
                zh_full = (translation or "").strip()
                zh_short = zh_full.split(";")[0].split("\n")[0].split("；")[0].strip()
                words.append({"word":word,"phonetic":phonetic or "","zh":zh_short,"zh_full":zh_full,"definition":(definition or "")[:200],"pos":pos or "","stage":stage_name})
            result[stage_name] = words
            print(f"  ✅ {stage_name}: {len(words)} 词")
        except Exception as e:
            print(f"  ❌ {stage_name}: {e}")
            result[stage_name] = []

    conn.close()
    print(f"📊 共提取 {sum(len(v) for v in result.values())} 词")
    return result

def build_html(vocab):
    vocab_json = json.dumps(vocab, ensure_ascii=False)
    
    html = r'''<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no,viewport-fit=cover"><title>英语学习工具</title>
<style>
:root{--bg:#0f172a;--s:#1e293b;--p:#38bdf8;--a:#f472b6;--t:#e2e8f0;--sub:#94a3b8;--b:#334155;--g:#4ade80;--r:#f87171;--w:#fbbf24}
*{margin:0;padding:0;box-sizing:border-box}html,body{height:100%;overflow:hidden}
body{font-family:'Segoe UI','PingFang SC',system-ui,sans-serif;background:var(--bg);color:var(--t);display:flex;justify-content:center;align-items:center;padding:10px;-webkit-tap-highlight-color:transparent;user-select:none}
.app{width:100%;max-width:820px;background:var(--s);border-radius:20px;box-shadow:0 30px 60px rgba(0,0,0,0.5);border:1px solid var(--b);height:95dvh;max-height:920px;display:flex;flex-direction:column;overflow:hidden}
.header{padding:12px 18px 8px;flex-shrink:0;display:flex;justify-content:space-between;align-items:center}
.logo{font-size:20px;font-weight:800;background:linear-gradient(135deg,var(--p),var(--a));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.nav{display:flex;gap:2px;padding:6px 12px;flex-shrink:0;overflow-x:auto;scrollbar-width:none}
.nav::-webkit-scrollbar{display:none}
.nav-btn{padding:10px 14px;border:none;background:transparent;color:var(--sub);font-size:13px;font-weight:600;border-radius:8px;cursor:pointer;white-space:nowrap;transition:all 0.15s}
.nav-btn.active{background:var(--p);color:#000}
.page{display:none;flex:1;overflow-y:auto;padding:12px 16px;-webkit-overflow-scrolling:touch}
.page.active{display:block}
.stage-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px;margin-bottom:14px}
.stage-card{background:#0f172a;border:2px solid var(--b);border-radius:8px;padding:10px;cursor:pointer;display:flex;align-items:center;gap:6px}
.stage-card:active{transform:scale(0.97)}.stage-card.selected{border-color:var(--a);background:rgba(244,114,182,0.1)}
.stage-card .check{width:16px;height:16px;border-radius:3px;border:2px solid var(--b);display:flex;align-items:center;justify-content:center;font-size:9px;flex-shrink:0}
.stage-card.selected .check{background:var(--a);border-color:var(--a);color:#000}
.stage-card .name{font-size:12px;font-weight:600}.stage-card .count{font-size:10px;color:var(--sub)}
.btn-start{width:100%;padding:12px;background:linear-gradient(135deg,var(--p),var(--a));border:none;border-radius:10px;color:#000;font-size:15px;font-weight:700;cursor:pointer}
.btn-start:disabled{opacity:0.4;cursor:not-allowed}
.card{background:#0f172a;border:1px solid var(--b);border-radius:16px;padding:32px 24px;text-align:center;margin-bottom:12px;min-height:220px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:12px}
.card .big{font-weight:800;color:#fff;word-break:break-all;line-height:1.2;font-size:62px}
.card .mid{color:var(--sub);line-height:1.4;font-size:24px}
.card .zh{font-weight:600;color:var(--a);line-height:1.5;transition:opacity 0.2s;font-size:34px}
.card .zh.hidden{opacity:0}
.progress-mini{height:4px;background:var(--b);border-radius:2px;margin-bottom:8px}
.progress-fill{height:100%;background:linear-gradient(90deg,var(--p),var(--a));border-radius:2px;transition:width 0.3s}
.btn-row{display:flex;gap:8px;flex-wrap:wrap;width:100%}
.btn{padding:14px 18px;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;flex:1;min-width:55px;transition:all 0.1s}
.btn:active{transform:scale(0.95)}
.btn-p{background:var(--p);color:#000}.btn-ac{background:transparent;color:var(--p);border:2px solid var(--p)}
.btn-g{background:var(--g);color:#000}.btn-r{background:var(--r);color:#fff}.btn-w{background:var(--w);color:#000}
.dict-links{display:flex;gap:8px;flex-wrap:wrap;width:100%;margin-top:4px}
.dict-link{padding:10px 14px;border-radius:8px;border:2px solid var(--a);background:transparent;color:var(--a);font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;text-align:center;flex:1;min-width:70px;transition:all 0.1s;display:inline-block}
.dict-link:active{transform:scale(0.95);background:rgba(244,114,182,0.15)}
.dict-input{width:100%;padding:14px;border-radius:8px;border:2px solid var(--b);background:#0f172a;color:#fff;font-size:22px;text-align:center;outline:none}
.dict-input.ok{border-color:var(--g)}.dict-input.no{border-color:var(--r)}
.fb{margin-top:8px;font-size:16px;min-height:22px;text-align:center}
.stats{display:flex;gap:8px;margin-top:10px;font-size:13px;color:var(--sub);justify-content:center}
.stats span{background:#0f172a;padding:4px 10px;border-radius:10px}
.num{color:var(--p);font-weight:700}.num.w{color:var(--w)}
.filter-list{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:10px}
.filter-item{display:flex;align-items:center;gap:5px;padding:7px 8px;background:#0f172a;border-radius:6px;border:1px solid var(--b);font-size:11px;cursor:pointer}
.filter-item.selected{border-color:var(--a);background:rgba(244,114,182,0.08)}
.filter-item .fi-check{width:14px;height:14px;border-radius:2px;border:2px solid var(--b);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:8px}
.filter-item.selected .fi-check{background:var(--a);border-color:var(--a);color:#000}
.filter-item .fi-word{flex:1;font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.filter-item .fi-zh{font-size:9px;color:var(--sub);max-width:50px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.filter-toolbar{display:flex;gap:6px;margin-bottom:10px;align-items:center;flex-wrap:wrap;font-size:11px}
.modal{position:fixed;background:var(--s);border:1px solid var(--p);border-radius:14px;padding:20px;z-index:1000;max-width:400px;width:90vw;max-height:80vh;overflow-y:auto;box-shadow:0 20px 50px rgba(0,0,0,0.7);top:50%;left:50%;transform:translate(-50%,-50%)}
.modal h3{font-size:17px;margin-bottom:10px;color:var(--p)}
.modal input,.modal select{width:100%;padding:8px;border-radius:6px;border:1px solid var(--b);background:#0f172a;color:#fff;font-size:15px;outline:none;text-align:center}
.modal-btns{display:flex;gap:6px;margin-top:12px;flex-wrap:wrap}.modal-btns button{flex:1;min-width:80px}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:999}
.toast{position:fixed;bottom:25px;left:50%;transform:translateX(-50%);background:var(--g);color:#000;padding:8px 18px;border-radius:14px;font-weight:600;font-size:14px;z-index:2000;animation:tIn 0.3s ease;pointer-events:none}
@keyframes tIn{from{opacity:0;transform:translateX(-50%) translateY(8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
.stat-card{cursor:pointer;transition:all 0.15s}
.stat-card:hover{border-color:var(--p);transform:translateY(-2px)}
.word-list-item{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid var(--b);font-size:14px}
.word-list-item .w{font-weight:600;color:var(--t)}
.word-list-item .z{color:var(--sub);font-size:12px;text-align:right;max-width:60%}
.phase-label{font-size:16px!important;font-weight:700!important;color:var(--w)!important}
@media(max-width:767px){body{padding:0;align-items:flex-start}.app{max-width:100vw;width:100vw;border-radius:0;height:100dvh;max-height:none;border:none;box-shadow:none}.card{min-height:180px;padding:24px 16px}.card .big{font-size:48px}.card .zh{font-size:28px}}
html[data-theme="light"] body{--bg:#fafaf9;--s:#fff;--t:#1a1a1a;--sub:#6b7280;--b:#d1d5db}
html[data-theme="light"] .card,html[data-theme="light"] .stage-card,html[data-theme="light"] .filter-item{background:#fff;border-color:#e5e7eb}
</style></head><body>
<div class="app">
<div class="header"><span class="logo">📚 English Trainer</span></div>
<div class="nav">
<button class="nav-btn active" data-page="select">📋选词</button><button class="nav-btn" data-page="filter">🔍筛选</button><button class="nav-btn" data-page="learn">📖学习</button><button class="nav-btn" data-page="deeplearn">🧠错题</button><button class="nav-btn" data-page="report">📊报告</button>
</div>
<div class="page active" id="page-select"><div style="font-size:17px;font-weight:700;margin-bottom:4px;">选择词库（可多选）</div><div style="font-size:13px;color:var(--sub);margin-bottom:10px;">选词库→设目标→筛选不认识→三遍学习</div><div class="stage-grid" id="stageGrid"></div><button class="btn-start" id="btnStart" disabled>请选择词库</button><div style="margin-top:12px;"><button class="btn btn-w" id="btnRandomReview" style="width:100%;">🎲 随机大复习</button></div></div>
<div class="page" id="page-filter"><div style="font-size:15px;font-weight:700;margin-bottom:2px;">🔍勾选<span style="color:var(--r);">不认识</span>的词</div><div style="font-size:12px;color:var(--sub);margin-bottom:6px;">已掌握的词汇自动跳过</div><div class="filter-toolbar"><button class="btn btn-ac" id="btnFilterAll" style="flex:0.3;">全选</button><button class="btn btn-ac" id="btnFilterNone" style="flex:0.3;">取消</button><span style="font-size:13px;color:var(--sub);flex:1;text-align:right;" id="filterProgress">已选0/目标0</span></div><div class="filter-list" id="filterList"></div><div class="btn-row"><button class="btn btn-w" id="btnFilterNext">🔄换一批</button><button class="btn btn-p" id="btnFilterDone">✅开始学习</button></div></div>
<div class="page" id="page-learn">
<div style="display:flex;justify-content:space-between;margin-bottom:8px;align-items:center;">
<span style="padding:3px 9px;border-radius:6px;background:rgba(244,114,182,0.15);color:var(--a);font-size:12px;font-weight:600" id="learnTag">—</span>
<span class="phase-label" id="learnPhase">—</span>
<span style="font-size:12px;color:var(--sub)" id="learnCount">0/0</span>
</div>
<div class="card" id="wordCard"><div class="big" id="wordEn">—</div><div class="mid" id="wordPhonetic"></div><div class="zh hidden" id="wordZh"></div></div>
<div class="progress-mini"><div class="progress-fill" id="groupProgress" style="width:0%"></div></div>
<div id="phaseBtns" class="btn-row"></div>
<div id="dictLinksBox" class="dict-links" style="display:none;"></div>
<div id="dictArea" style="display:none;"><input type="text" class="dict-input" id="dictInput" placeholder="输入英文拼写..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"><div class="fb" id="dictFeedback"></div><div class="btn-row" style="margin-top:8px;"><button class="btn btn-p" id="btnDictCheck">✅确认</button></div></div>
<div class="stats"><span>✅<span class="num" id="knownNum">0</span></span><span>📝<span class="num w" id="reviewNum">0</span></span></div>
</div>
<div class="page" id="page-deeplearn"><div style="font-size:16px;font-weight:700;margin-bottom:8px;">🧠错题深度学习</div><div id="deepContent"></div></div>
<div class="page" id="page-report"><div style="font-size:16px;font-weight:700;margin-bottom:8px;">📊学习报告（点击卡片查看详情）</div><div id="reportContent"></div></div>
</div>
<div class="overlay" id="goalOverlay" style="display:none;"></div><div class="modal" id="goalModal" style="display:none;"><h3>🎯今天想学多少个新词？</h3><input type="number" id="goalInput" min="5" max="200" value="20"><div class="modal-btns"><button class="btn btn-ac" id="btnGoalCancel">取消</button><button class="btn btn-p" id="btnGoalConfirm">开始筛选</button></div></div>
<div class="overlay" id="detailOverlay" style="display:none;"></div><div class="modal" id="detailModal" style="display:none;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><h3 id="detailTitle">详情</h3><button class="btn btn-ac" id="btnDetailClose" style="flex:0;min-width:40px;padding:6px 10px;">✕</button></div><div id="detailContent"></div><div class="modal-btns" id="detailExportBtns"></div></div>
<div class="overlay" id="reviewOverlay" style="display:none;"></div><div class="modal" id="reviewModal" style="display:none;"><h3>🎲随机大复习</h3><div style="font-size:13px;color:var(--sub);margin-bottom:8px;">从已掌握的词汇中随机抽取</div><div style="margin-bottom:8px;font-size:12px;color:var(--sub);">抽取数量<select id="reviewCount" style="width:100%;margin-top:2px;"><option value="10">10个</option><option value="20" selected>20个</option><option value="30">30个</option><option value="50">50个</option></select></div><div class="modal-btns"><button class="btn btn-ac" id="btnReviewCancel">取消</button><button class="btn btn-p" id="btnReviewStart">开始默写</button></div></div>
<div class="toast" id="toast" style="display:none;"></div>
<script>
var vd=__VOCAB_DATA__;var ss=new Set();
var kw=new Set(JSON.parse(localStorage.getItem('et_known')||'[]'));
var wb=JSON.parse(localStorage.getItem('et_wrong')||'{}');
var settings=JSON.parse(localStorage.getItem('et_settings')||'{"theme":"dark","fontSize":"large","autoSpeak":true}');
var log=JSON.parse(localStorage.getItem('et_log')||'{}');
var tc=parseInt(localStorage.getItem('et_today')||'0');
var filterWords=[],filterSelected=new Set(),filterGoal=20;
var allWords=[],groupSize=10,groupIdx=0,wordIdx=0;
var phase=0,phases=['📖 学词(跟读记忆)','🧠 回忆(看英文想中文)','✍️ 默写(看中文写英文)'];
var curPhonetic='us',synth=window.speechSynthesis||null;
var reviewWords=[];
console.log('✅词库:',Object.keys(vd).length,'个');

function sv(){localStorage.setItem('et_known',JSON.stringify([...kw]));localStorage.setItem('et_wrong',JSON.stringify(wb));localStorage.setItem('et_settings',JSON.stringify(settings));localStorage.setItem('et_log',JSON.stringify(log));localStorage.setItem('et_today',String(tc));}
function aw(w){if(!wb[w])wb[w]=0;sv();}
function rw(w){delete wb[w];sv();}
function st(m){var t=document.getElementById('toast');t.textContent=m;t.style.display='block';clearTimeout(t._tid);t._tid=setTimeout(function(){t.style.display='none';},2000);}
function sp(n){document.querySelectorAll('.nav-btn').forEach(function(b){b.classList.remove('active');});document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active');});document.querySelector('[data-page="'+n+'"]').classList.add('active');document.getElementById('page-'+n).classList.add('active');if(n==='report')renderReport();if(n==='deeplearn')renderDeep();if(n==='select')rsg();}
function speak(w){if(!synth)return;synth.cancel();var u=new SpeechSynthesisUtterance(w);u.lang=curPhonetic==='us'?'en-US':'en-GB';u.rate=0.85;u.volume=1;synth.speak(u);}
function findWord(word){for(var s of Object.keys(vd)){var f=vd[s].find(function(x){return x.word.toLowerCase()===word.toLowerCase();});if(f)return f;}return{word:word,phonetic:'',zh:'',zh_full:''};}

function showDictLinks(word){var e=encodeURIComponent(word);var links=[{name:'有道',url:'https://www.youdao.com/result?word='+e+'&lang=en'},{name:'剑桥',url:'https://dictionary.cambridge.org/dictionary/english-chinese-simplified/'+e},{name:'柯林斯',url:'https://www.collinsdictionary.com/dictionary/english/'+e},{name:'牛津',url:'https://www.oxfordlearnersdictionaries.com/definition/english/'+e}];var box=document.getElementById('dictLinksBox');box.innerHTML='<span style="font-size:12px;color:var(--sub);width:100%;">📖 深度学习（词组/搭配/近义词）：</span>'+links.map(function(l){return'<a class="dict-link" target="_blank" href="'+l.url+'">'+l.name+'</a>';}).join('');box.style.display='flex';}

function rsg(){var g=document.getElementById('stageGrid');g.innerHTML=Object.keys(vd).map(function(s){var c=vd[s].length,sel=ss.has(s);return'<div class="stage-card'+(sel?' selected':'')+'" data-stage="'+s+'"><div class="check">'+(sel?'✓':'')+'</div><div><div class="name">'+s+'</div><div class="count">'+c+'词</div></div></div>';}).join('');g.querySelectorAll('.stage-card').forEach(function(c){c.addEventListener('click',function(){var s=this.dataset.stage;ss.has(s)?ss.delete(s):ss.add(s);rsg();usb();});});usb();}
function usb(){var b=document.getElementById('btnStart'),t=0;ss.forEach(function(s){t+=vd[s].length;});b.disabled=ss.size===0;b.textContent=ss.size===0?'请选择词库':'🚀开始('+ss.size+'库,'+t+'词)';}
rsg();

document.getElementById('btnRandomReview').addEventListener('click',function(){if(kw.size===0){st('暂无已掌握的词汇');return;}document.getElementById('reviewOverlay').style.display='block';document.getElementById('reviewModal').style.display='block';});
document.getElementById('btnReviewCancel').addEventListener('click',function(){document.getElementById('reviewOverlay').style.display='none';document.getElementById('reviewModal').style.display='none';});
document.getElementById('btnReviewStart').addEventListener('click',function(){var count=parseInt(document.getElementById('reviewCount').value)||20;var pool=[...kw];for(var i=pool.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var t=pool[i];pool[i]=pool[j];pool[j]=t;}reviewWords=pool.slice(0,Math.min(count,pool.length)).map(function(w){return findWord(w);});document.getElementById('reviewOverlay').style.display='none';document.getElementById('reviewModal').style.display='none';allWords=reviewWords;groupSize=10;groupIdx=0;wordIdx=0;phase=2;sp('learn');startPhase();});

document.getElementById('btnStart').addEventListener('click',function(){if(ss.size===0)return;document.getElementById('goalOverlay').style.display='block';document.getElementById('goalModal').style.display='block';document.getElementById('goalInput').value='20';document.getElementById('goalInput').focus();});
document.getElementById('btnGoalCancel').addEventListener('click',function(){document.getElementById('goalOverlay').style.display='none';document.getElementById('goalModal').style.display='none';});
document.getElementById('btnGoalConfirm').addEventListener('click',function(){filterGoal=Math.max(5,Math.min(200,parseInt(document.getElementById('goalInput').value)||20));document.getElementById('goalOverlay').style.display='none';document.getElementById('goalModal').style.display='none';filterWords=[];filterSelected=new Set();var all=[];ss.forEach(function(s){all=all.concat(vd[s]);});for(var i=all.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var t=all[i];all[i]=all[j];all[j]=t;}filterWords=all.filter(function(w){return!kw.has(w.word);});if(filterWords.length===0){st('✅该词库已全部掌握！');return;}sp('filter');loadFilter();});

function loadFilter(){var batch=filterWords.slice(0,20);document.getElementById('filterList').innerHTML=batch.map(function(w){var sel=filterSelected.has(w.word);return'<div class="filter-item'+(sel?' selected':'')+'" data-word="'+w.word+'"><div class="fi-check">'+(sel?'✓':'')+'</div><div class="fi-word">'+w.word+'</div><div class="fi-zh">'+(w.zh||'')+'</div></div>';}).join('');document.getElementById('filterProgress').textContent='已选'+filterSelected.size+'/目标'+filterGoal;document.querySelectorAll('#filterList .filter-item').forEach(function(item){item.onclick=function(){var w=this.dataset.word;filterSelected.has(w)?filterSelected.delete(w):filterSelected.add(w);this.classList.toggle('selected');this.querySelector('.fi-check').textContent=filterSelected.has(w)?'✓':'';document.getElementById('filterProgress').textContent='已选'+filterSelected.size+'/目标'+filterGoal;};});}
document.getElementById('btnFilterAll').addEventListener('click',function(){document.querySelectorAll('#filterList .filter-item').forEach(function(item){filterSelected.add(item.dataset.word);item.classList.add('selected');item.querySelector('.fi-check').textContent='✓';});document.getElementById('filterProgress').textContent='已选'+filterSelected.size+'/目标'+filterGoal;});
document.getElementById('btnFilterNone').addEventListener('click',function(){document.querySelectorAll('#filterList .filter-item').forEach(function(item){filterSelected.delete(item.dataset.word);item.classList.remove('selected');item.querySelector('.fi-check').textContent='';});document.getElementById('filterProgress').textContent='已选'+filterSelected.size+'/目标'+filterGoal;});
document.getElementById('btnFilterNext').addEventListener('click',function(){loadFilter();});
document.getElementById('btnFilterDone').addEventListener('click',function(){if(filterSelected.size===0){st('请至少勾选一个不认识的词');return;}allWords=filterWords.filter(function(w){return filterSelected.has(w.word);});for(var i=allWords.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var t=allWords[i];allWords[i]=allWords[j];allWords[j]=t;}groupIdx=0;wordIdx=0;phase=0;sp('learn');startPhase();});

function currentWord(){return allWords[groupIdx*groupSize+wordIdx];}
function groupWords(){return allWords.slice(groupIdx*groupSize,groupIdx*groupSize+groupSize);}
function updateProgress(){document.getElementById('learnCount').textContent=(groupIdx*groupSize+wordIdx+1)+'/'+allWords.length;document.getElementById('groupProgress').style.width=((wordIdx)/groupSize*100)+'%';}

function startPhase(){wordIdx=0;var gw=groupWords();document.getElementById('learnPhase').textContent='阶段：'+phases[phase];document.getElementById('learnTag').textContent='第'+(groupIdx+1)+'组('+gw.length+'词)';document.getElementById('dictLinksBox').style.display='none';updateProgress();if(phase===0)renderLearn();else if(phase===1)renderRecall();else if(phase===2)renderSpell();}

function renderLearn(){var w=currentWord();document.getElementById('wordEn').textContent=w.word;document.getElementById('wordPhonetic').textContent=(w.phonetic||'')+' '+(w.zh_full||w.zh||'');document.getElementById('wordZh').textContent='';document.getElementById('wordZh').classList.add('hidden');document.getElementById('dictArea').style.display='none';showDictLinks(w.word);document.getElementById('phaseBtns').innerHTML='<button class="btn btn-p" id="btnNextLearn">下一个▶</button><button class="btn btn-ac" id="btnSpeakLearn">🔊朗读</button>';document.getElementById('btnNextLearn').onclick=function(){wordIdx++;if(wordIdx>=groupWords().length){phase=1;startPhase();}else{renderLearn();}};document.getElementById('btnSpeakLearn').onclick=function(){speak(w.word);};if(settings.autoSpeak!==false)speak(w.word);}

function renderRecall(){var w=currentWord();document.getElementById('wordEn').textContent=w.word;document.getElementById('wordPhonetic').textContent=w.phonetic||'';document.getElementById('wordZh').textContent=w.zh_full||w.zh||'';document.getElementById('wordZh').classList.add('hidden');document.getElementById('dictArea').style.display='none';document.getElementById('phaseBtns').innerHTML='<button class="btn btn-ac" id="btnShowZh">显示中文</button><button class="btn btn-p" id="btnNextRecall">下一个▶</button>';document.getElementById('btnShowZh').onclick=function(){document.getElementById('wordZh').classList.remove('hidden');};document.getElementById('btnNextRecall').onclick=function(){wordIdx++;if(wordIdx>=groupWords().length){phase=2;startPhase();}else{renderRecall();}};}

function renderSpell(){var w=currentWord();document.getElementById('wordEn').textContent='';document.getElementById('wordPhonetic').textContent='';document.getElementById('wordZh').textContent=w.zh_full||w.zh||'';document.getElementById('wordZh').classList.remove('hidden');document.getElementById('dictArea').style.display='block';document.getElementById('dictInput').value='';document.getElementById('dictInput').className='dict-input';document.getElementById('dictFeedback').textContent='';document.getElementById('dictInput').focus();document.getElementById('phaseBtns').innerHTML='';document.getElementById('btnDictCheck').onclick=function(){var ip=document.getElementById('dictInput').value.trim().toLowerCase();if(!ip)return;if(ip===w.word.toLowerCase()){document.getElementById('dictInput').className='dict-input ok';document.getElementById('dictFeedback').innerHTML='<span style="color:var(--g)">✅正确!</span>';}else{document.getElementById('dictInput').className='dict-input no';document.getElementById('dictFeedback').innerHTML='<span style="color:var(--r)">❌正确:'+w.word+'</span>';aw(w.word);}setTimeout(function(){wordIdx++;if(wordIdx>=groupWords().length){nextGroup();}else{renderSpell();}},800);};document.getElementById('dictInput').onkeydown=function(e){if(e.key==='Enter')document.getElementById('btnDictCheck').click();};}

function nextGroup(){groupIdx++;var totalGroups=Math.ceil(allWords.length/groupSize);if(groupIdx>=totalGroups){for(var i=0;i<allWords.length;i++){kw.add(allWords[i].word);}tc+=allWords.length;var d=new Date().toISOString().slice(0,10);if(!log[d])log[d]={newWords:0,review:0};log[d].newWords+=allWords.length;sv();st('🎉恭喜完成！'+allWords.length+'个词已掌握');us();sp('select');return;}phase=0;wordIdx=0;startPhase();}

function showDetail(title,words,showExport){document.getElementById('detailTitle').textContent=title;var html='<div style="max-height:50vh;overflow-y:auto;">';words.forEach(function(w,i){html+='<div class="word-list-item"><span class="w">'+w.word+'</span><span class="z">'+w.zh+'</span></div>';});html+='</div>';document.getElementById('detailContent').innerHTML=html;if(showExport){document.getElementById('detailExportBtns').innerHTML='<button class="btn btn-ac btn-export" data-type="en">📄仅英文</button><button class="btn btn-ac btn-export" data-type="zh">📄仅中文</button><button class="btn btn-ac btn-export" data-type="both">📄中英对照</button>';document.querySelectorAll('.btn-export').forEach(function(b){b.onclick=function(){exportPDF(words,this.dataset.type);};});}else{document.getElementById('detailExportBtns').innerHTML='';}document.getElementById('detailOverlay').style.display='block';document.getElementById('detailModal').style.display='block';}

function exportPDF(words,type){var printWindow=window.open('','_blank','width=800,height=600');var title='英语学习词汇表';var html='<!DOCTYPE html><html><head><meta charset="UTF-8"><title>'+title+'</title><style>body{font-family:"SimSun","Times New Roman",serif;padding:20px;}h1{text-align:center;font-size:18px;margin-bottom:10px;}table{width:100%;border-collapse:collapse;margin-top:10px;}td,th{border:1px solid #000;padding:6px 8px;font-size:14px;text-align:left;}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}@page{size:A4;margin:15mm;}}</style></head><body><h1>'+title+'</h1><table>';if(type==='en'){html+='<tr><th>#</th><th>英文</th></tr>';words.forEach(function(w,i){html+='<tr><td>'+(i+1)+'</td><td>'+w.word+'</td></tr>';});}else if(type==='zh'){html+='<tr><th>#</th><th>中文</th></tr>';words.forEach(function(w,i){html+='<tr><td>'+(i+1)+'</td><td>'+w.zh+'</td></tr>';});}else{html+='<tr><th>#</th><th>英文</th><th>中文</th></tr>';words.forEach(function(w,i){html+='<tr><td>'+(i+1)+'</td><td>'+w.word+'</td><td>'+w.zh+'</td></tr>';});}html+='</table></body></html>';printWindow.document.write(html);printWindow.document.close();setTimeout(function(){printWindow.print();},500);}

document.getElementById('detailOverlay').addEventListener('click',function(){document.getElementById('detailOverlay').style.display='none';document.getElementById('detailModal').style.display='none';});
document.getElementById('btnDetailClose').addEventListener('click',function(){document.getElementById('detailOverlay').style.display='none';document.getElementById('detailModal').style.display='none';});

function renderReport(){var knownList=[...kw].map(function(w){return findWord(w);});var wrongList=Object.keys(wb).map(function(w){return findWord(w);});document.getElementById('reportContent').innerHTML='<div class="card stat-card" id="cardKnown" style="min-height:auto;padding:16px;"><div class="big" style="color:var(--p);font-size:28px;">'+kw.size+'</div><div style="color:var(--sub);">已掌握词汇</div></div><div class="card stat-card" id="cardWrong" style="min-height:auto;padding:16px;"><div class="big" style="color:var(--w);font-size:28px;">'+Object.keys(wb).length+'</div><div style="color:var(--sub);">错题本</div></div><div class="card stat-card" id="cardToday" style="min-height:auto;padding:16px;"><div class="big" style="color:var(--g);font-size:28px;">'+tc+'</div><div style="color:var(--sub);">今日已学</div></div>';document.getElementById('cardKnown').onclick=function(){showDetail('已掌握词汇',knownList,true);};document.getElementById('cardWrong').onclick=function(){showDetail('错题本',wrongList,true);};document.getElementById('cardToday').onclick=function(){var today=new Date().toISOString().slice(0,10);var todayWords=(log[today]&&log[today].newWords>0)?knownList.slice(-log[today].newWords):knownList.slice(-tc);showDetail('今日已学',todayWords,true);};}

function renderDeep(){var ws=Object.keys(wb).map(function(w){return findWord(w);});if(ws.length===0){document.getElementById('deepContent').innerHTML='<div class="card"><div style="color:var(--sub);">✅错题本为空！</div></div>';return;}var html='<div style="font-size:13px;color:var(--sub);margin-bottom:8px;">'+ws.length+'个待攻克（点击移除）</div>';ws.forEach(function(w){html+='<div class="card" style="min-height:auto;padding:12px;margin-bottom:6px;flex-direction:row;justify-content:space-between;text-align:left;"><div><div class="big" style="font-size:22px;">'+w.word+'</div><div style="font-size:14px;color:var(--sub);">'+(w.zh_full||w.zh||'')+'</div></div><button class="btn btn-g" style="flex:0;min-width:50px;padding:6px 10px;font-size:13px;" id="deepRm'+w.word+'">移除</button></div>';});document.getElementById('deepContent').innerHTML=html;ws.forEach(function(w){document.getElementById('deepRm'+w.word).onclick=function(){rw(w.word);renderDeep();st('已移出错题本');};});}

document.querySelectorAll('.nav-btn').forEach(function(b){b.addEventListener('click',function(){sp(this.dataset.page);});});
function us(){document.getElementById('knownNum').textContent=kw.size;document.getElementById('reviewNum').textContent=Object.keys(wb).length;}
us();console.log('🚀就绪');
</script></body></html>'''

    # 用 replace 方式注入词库数据，避免 f-string 花括号冲突
    html = html.replace('__VOCAB_DATA__', vocab_json)

    output_path = BASE_DIR / "英语学习工具.html"
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"💾 已生成: 英语学习工具.html ({output_path.stat().st_size/1024/1024:.1f}MB)")
    return output_path

def main():
    print("=" * 50)
    print("📚 英语学习工具")
    print("=" * 50)
    vocab = extract_from_ecdic()
    if vocab is None:
        print("\n❌ 词库构建失败")
        return
    html_path = build_html(vocab)
    try:
        os.startfile(str(html_path))
        print("🌐 已在浏览器中打开")
    except:
        print(f"📁 请手动打开: {html_path}")
    print("\n🎉 完成！")

if __name__ == "__main__":
    main()