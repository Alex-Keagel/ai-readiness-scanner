import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TACTICAL_GLASSBOX_CSS } from './theme';
import { logger } from '../logging';
import { DeveloperProfile } from '../live/developerNetwork';

export class DeveloperNetworkPanel {
  public static currentPanel: DeveloperNetworkPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private refreshCallback?: () => Promise<DeveloperProfile>;

  private constructor(panel: vscode.WebviewPanel, profile: DeveloperProfile, extensionUri: vscode.Uri, refreshCallback?: () => Promise<DeveloperProfile>) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.refreshCallback = refreshCallback;
    try {
      this.panel.webview.html = this.getHtml(profile, extensionUri);
    } catch (err) {
      logger.error('DeveloperNetworkPanel render failed', err);
      this.panel.webview.html = '<html><body><h2>Error</h2><pre>' + String(err) + '</pre></body></html>';
    }
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'refresh' && this.refreshCallback) {
        try {
          const newProfile = await this.refreshCallback();
          this.panel.webview.html = this.getHtml(newProfile, this.extensionUri);
        } catch (err) {
          logger.error('DeveloperNetworkPanel refresh failed', err);
        }
      }
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static createOrShow(profile: DeveloperProfile, extensionUri: vscode.Uri, refreshCallback?: () => Promise<DeveloperProfile>): void {
    try {
      const column = vscode.ViewColumn.One;
      if (DeveloperNetworkPanel.currentPanel) {
        DeveloperNetworkPanel.currentPanel.refreshCallback = refreshCallback;
        DeveloperNetworkPanel.currentPanel.panel.webview.html = DeveloperNetworkPanel.currentPanel.getHtml(profile, extensionUri);
        DeveloperNetworkPanel.currentPanel.panel.reveal(column);
        return;
      }
      const panel = vscode.window.createWebviewPanel('devProfile', '\u{1F464} Developer Profile', column, { enableScripts: true, retainContextWhenHidden: true });
      DeveloperNetworkPanel.currentPanel = new DeveloperNetworkPanel(panel, profile, extensionUri, refreshCallback);
    } catch (err) { logger.error('DeveloperNetworkPanel: failed', err); }
  }

  private dispose(): void {
    DeveloperNetworkPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
  }

  private esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/`/g, '&#96;'); }

  private formatNumber(n: number): string {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  private getHtml(profile: DeveloperProfile, extensionUri: vscode.Uri): string {
    if (!profile.currentUser) {
      return '<!DOCTYPE html><html><head><style>' + TACTICAL_GLASSBOX_CSS + '</style></head><body style="padding:40px;text-align:center"><h2>\u{1F464} Developer Profile</h2><p>No data. Run <code>az login</code> and have ADO repos cloned locally.</p></body></html>';
    }
    let d3Code = '';
    try { d3Code = fs.readFileSync(path.join(extensionUri.fsPath, 'dist', 'd3-bundle.js'), 'utf8'); } catch { return '<html><body>D3 not found</body></html>'; }

    const dataJson = JSON.stringify(profile);
    const css = this.getCss();
    const script = this.buildScript();
    const insights = this.buildInsights(profile);

    return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' + TACTICAL_GLASSBOX_CSS + '\n' + css + '</style></head><body>'
      + '<div id="header"><div class="hero"><span class="hero-icon">\u{1F464}</span><div><div class="hero-name">' + this.esc(profile.currentUser) + '</div><div class="hero-alias">@' + this.esc(profile.currentAlias) + '</div></div></div>'
      + '<div class="hero-stats">'
      + '<div class="hs"><span class="hsv">' + profile.totalPRsCreated + '</span><span class="hsl">PRs Authored</span></div>'
      + '<div class="hs"><span class="hsv">' + profile.totalPRsReviewed + '</span><span class="hsl">PRs Reviewed</span></div>'
      + '<div class="hs"><span class="hsv">' + profile.totalCommits + '</span><span class="hsl">Commits</span></div>'
      + '<div class="hs"><span class="hsv">' + this.formatNumber(profile.totalLinesAdded) + '</span><span class="hsl">Lines Added</span></div>'
      + '<div class="hs"><span class="hsv">' + profile.repos.length + '</span><span class="hsl">Repos</span></div>'
      + '<div class="hs"><span class="hsv">' + profile.people.length + '</span><span class="hsl">Collaborators</span></div>'
      + '</div>'
      + '<button id="refresh-btn" title="Refresh data">\u{1F504} Refresh</button>'
      + '</div>'
      + '<div id="main"><div id="graph-area"><svg id="svg"></svg></div>'
      + '<div id="detail" class="hidden"><button id="close-detail">\u2715</button><div id="detail-content"></div></div></div>'
      + insights
      + '<script>' + d3Code + '</script><script>var P=' + dataJson + ';</script><script>' + script + '</script></body></html>';
  }

  private getCss(): string {
    return 'body{margin:0;overflow-y:auto}#header{padding:16px 24px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:20px;flex-wrap:wrap}.hero{display:flex;align-items:center;gap:12px}.hero-icon{font-size:2.5em}.hero-name{font-size:1.3em;font-weight:700}.hero-alias{font-size:.85em;color:var(--text-secondary)}.hero-stats{display:flex;gap:14px;margin-left:auto;flex-wrap:wrap}.hs{text-align:center;padding:8px 14px;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:8px}.hsv{display:block;font-size:1.4em;font-weight:700;color:var(--color-cyan)}.hsl{font-size:.7em;color:var(--text-secondary);text-transform:uppercase}#main{display:flex;height:65vh;position:relative}#graph-area{flex:1}#svg{width:100%;height:100%}.label{font-size:10px;fill:var(--text-primary);pointer-events:none;text-anchor:middle}#detail{position:absolute;top:0;right:0;bottom:0;width:340px;background:var(--bg-card);border-left:1px solid var(--border-subtle);padding:16px;overflow-y:auto;z-index:100;transition:transform .2s}#detail.hidden{transform:translateX(100%)}#close-detail{position:absolute;top:8px;right:8px;background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:1.2em}.dn{font-size:1.1em;font-weight:700;margin-bottom:4px}.ds{font-size:.82em;color:var(--text-secondary);margin-bottom:12px}.dr{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-subtle);font-size:.88em}.dv{font-weight:600}.dsec{margin-top:12px}.dsec strong{font-size:.85em}.di{padding:3px 0;font-size:.82em;color:var(--text-secondary)}#insights{padding:20px 24px;display:flex;gap:24px;flex-wrap:wrap}.isec{flex:1;min-width:280px}.isec h3{font-size:1em;margin:0 0 12px}.ftr{display:flex;align-items:center;gap:8px;font-size:.85em;margin:4px 0}.fte{width:45px;text-align:right;color:var(--text-secondary)}.ftb{flex:1;height:8px;background:var(--bg-elevated);border-radius:4px}.ftf{height:100%;background:var(--color-cyan);border-radius:4px}.ftp{width:35px;font-size:.82em;color:var(--text-secondary)}.cc{display:flex;align-items:center;gap:10px;padding:8px;margin:4px 0;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:8px}.ccn{font-weight:600;font-size:.9em}.ccd{font-size:.78em;color:var(--text-secondary)}.ccs{margin-left:auto;font-size:1.1em;font-weight:700;color:var(--color-cyan)}.code-stats{margin-top:14px;padding:12px;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:8px}.cs-row{display:flex;justify-content:space-between;padding:4px 0;font-size:.88em}.cs-row.cs-net{border-top:1px solid var(--border-subtle);margin-top:4px;padding-top:8px;font-weight:600}.cs-label{color:var(--text-secondary)}.cs-val{font-weight:600}.cs-add{color:#3fb950}.cs-del{color:#f85149}.cs-repos{margin-top:10px}.cs-repo{display:flex;gap:8px;align-items:center;padding:3px 0;font-size:.82em}.cs-rname{flex:1;color:var(--text-secondary)}.cs-repo .cs-add,.cs-repo .cs-del{font-size:.82em;min-width:50px;text-align:right}.repo-ft{margin-bottom:14px;padding:10px;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:8px}.repo-ft-name{font-weight:600;font-size:.88em;margin-bottom:6px}#refresh-btn{padding:6px 14px;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:6px;color:var(--text-primary);cursor:pointer;font-size:.82em;transition:background .2s}#refresh-btn:hover{background:var(--bg-elevated)}#refresh-btn.loading{opacity:.5;pointer-events:none}';
  }

  private buildInsights(p: DeveloperProfile): string {
    // Per-repo file type breakdown
    const repoSections = p.repos
      .filter(r => Object.keys(r.myFileTypes).length > 0)
      .sort((a, b) => (b.myLinesAdded || 0) - (a.myLinesAdded || 0))
      .slice(0, 6)
      .map(r => {
        const ftEntries = Object.entries(r.myFileTypes).sort((a, b) => b[1] - a[1]);
        const total = ftEntries.reduce((s, [, c]) => s + c, 0) || 1;
        const bars = ftEntries.slice(0, 5).map(([ext, count]) => {
          const pct = Math.round(count / total * 100);
          return '<div class="ftr"><span class="fte">.' + this.esc(ext) + '</span><div class="ftb"><div class="ftf" style="width:' + pct + '%"></div></div><span class="ftp">' + pct + '%</span></div>';
        }).join('');
        const lines = (r.myLinesAdded > 0 || r.myCommits > 0)
          ? ' <span style="font-size:.75em;color:var(--text-secondary)">'
            + (r.myCommits > 0 ? r.myCommits + ' commits' : '')
            + (r.myCommits > 0 && r.myLinesAdded > 0 ? ' · ' : '')
            + (r.myLinesAdded > 0 ? '<span class="cs-add">+' + this.formatNumber(r.myLinesAdded) + '</span> <span class="cs-del">-' + this.formatNumber(r.myLinesDeleted) + '</span>' : '')
            + '</span>'
          : '';
        return '<div class="repo-ft"><div class="repo-ft-name">\u{1F4C1} ' + this.esc(r.name) + lines + '</div>' + bars + '</div>';
      }).join('');

    // Code volume summary
    const totalNet = p.totalLinesAdded - p.totalLinesDeleted;
    const codeStats = p.totalLinesAdded > 0
      ? '<div class="code-stats">'
        + '<div class="cs-row"><span class="cs-label">Total Lines Added</span><span class="cs-val cs-add">+' + this.formatNumber(p.totalLinesAdded) + '</span></div>'
        + '<div class="cs-row"><span class="cs-label">Total Lines Deleted</span><span class="cs-val cs-del">-' + this.formatNumber(p.totalLinesDeleted) + '</span></div>'
        + '<div class="cs-row cs-net"><span class="cs-label">Net</span><span class="cs-val">' + (totalNet >= 0 ? '+' : '') + this.formatNumber(totalNet) + '</span></div>'
        + '</div>'
      : '';

    // Top collaborators
    const collabs = p.topCollaborators.slice(0, 6).map(c => {
      const pe = p.people.find(pp => pp.name === c.name);
      const d = pe ? (pe.theyReviewedMyPRs + ' reviewed yours \u00B7 ' + pe.iReviewedTheirPRs + ' you reviewed') : '';
      return '<div class="cc"><span>\u{1F91D}</span><div><div class="ccn">' + this.esc(c.name) + '</div><div class="ccd">' + d + '</div></div><span class="ccs">' + c.score + '</span></div>';
    }).join('');

    return '<div id="insights">'
      + '<div class="isec"><h3>\u{1F4CA} What You Work On</h3>' + repoSections + codeStats + '</div>'
      + '<div class="isec"><h3>\u{1F91D} Top Collaborators</h3>' + collabs + '</div>'
      + '</div>';
  }

  private buildScript(): string {
    return '(function(){'
      + 'var p=P;'
      + 'function fmt(n){if(n>=1000000)return(n/1000000).toFixed(1)+"M";if(n>=1000)return(n/1000).toFixed(1)+"K";return String(n);}'
      + 'var svg=d3.select("#svg");var area=document.getElementById("graph-area");'
      + 'var w=area.clientWidth,h=area.clientHeight;'
      + 'svg.attr("width",w).attr("height",h);'
      + 'var g=svg.append("g");'
      + 'svg.call(d3.zoom().scaleExtent([0.2,4]).on("zoom",function(e){g.attr("transform",e.transform);}));'

      // Build nodes
      + 'var nodes=[{id:"me",type:"me",label:p.currentUser}];'
      + 'var nodeMap={"me":nodes[0]};'
      + 'var nRepos=p.repos.length;'
      + 'for(var i=0;i<nRepos;i++){'
      +   'var r=p.repos[i];'
      +   'var angle=-Math.PI/2+(Math.PI*i/(Math.max(nRepos-1,1)));'
      +   'var n={id:"repo-"+r.name,type:"repo",label:r.name,data:r,x:w/2+Math.cos(angle)*280,y:h/2+Math.sin(angle)*240};'
      +   'nodes.push(n);nodeMap[n.id]=n;'
      + '}'
      + 'var ppl=[];'
      + 'for(var i=0;i<p.people.length;i++){'
      +   'var pe=p.people[i];var act=pe.theyReviewedMyPRs+pe.iReviewedTheirPRs;'
      +   'if(act<1)continue;'
      +   'ppl.push(pe);'
      + '}'
      + 'var nPpl=ppl.length;'
      + 'for(var i=0;i<nPpl;i++){'
      +   'var pe=ppl[i];var act=pe.theyReviewedMyPRs+pe.iReviewedTheirPRs;'
      +   'var angle=Math.PI/2+(Math.PI*i/(Math.max(nPpl-1,1)));'
      +   'var n={id:"person-"+pe.name,type:"person",label:pe.name,data:pe,act:act,x:w/2+Math.cos(angle)*220,y:h/2+Math.sin(angle)*200};'
      +   'nodes.push(n);nodeMap[n.id]=n;'
      + '}'

      // Build links: me→repos, me→people, people→repos
      + 'var links=[];'
      + 'for(var i=0;i<nRepos;i++){'
      +   'var r=p.repos[i];'
      +   'links.push({source:"me",target:"repo-"+r.name,type:"me-repo",w:Math.min(8,r.myPRsCreated+r.myPRsReviewed),stats:{prsAuthored:r.myPRsCreated,prsReviewed:r.myPRsReviewed,comments:r.myComments,commits:r.myCommits||0,linesAdded:r.myLinesAdded||0,linesDeleted:r.myLinesDeleted||0},personName:p.currentUser,repoName:r.name});'
      + '}'
      + 'for(var i=0;i<nPpl;i++){'
      +   'var pe=ppl[i];var act=pe.theyReviewedMyPRs+pe.iReviewedTheirPRs;'
      +   'if(!nodeMap["person-"+pe.name])continue;'
      +   'links.push({source:"me",target:"person-"+pe.name,type:"me-person",w:Math.min(6,act),stats:{theyReviewedMine:pe.theyReviewedMyPRs,iReviewedTheirs:pe.iReviewedTheirPRs,theirComments:pe.theyCommentedOnMyPRs,myComments:pe.iCommentedOnTheirPRs,sharedRepos:(pe.sharedRepos||[]).length},personName:pe.name,repoName:""});'
      +   'var cr=pe.contributedRepos||pe.sharedRepos||[];'
      +   'var rs=pe.repoStats||{};'
      +   'for(var j=0;j<cr.length;j++){'
      +     'var rid="repo-"+cr[j];'
      +     'var st=rs[cr[j]]||{prsAuthored:0,prsReviewed:0,comments:0};'
      +     'if(nodeMap[rid])links.push({source:"person-"+pe.name,target:rid,type:"person-repo",w:Math.max(1,Math.min(4,st.prsAuthored+st.prsReviewed)),stats:st,personName:pe.name,repoName:cr[j]});'
      +   '}'
      + '}'

      // Center me
      + 'nodes[0].fx=w/2;nodes[0].fy=h/2;'

      // Simulation — strong repulsion + dynamic collision radius for label chips
      + 'var sim=d3.forceSimulation(nodes)'
      +   '.force("link",d3.forceLink(links).id(function(d){return d.id;}).distance(function(l){'
      +     'return l.type==="me-repo"?200:l.type==="me-person"?160:120;'
      +   '}).strength(function(l){return l.type==="person-repo"?0.08:0.4;}))'
      +   '.force("charge",d3.forceManyBody().strength(-600))'
      +   '.force("collide",d3.forceCollide(function(d){'
      +     'return d.type==="repo"?(d.tw||100)/2+20:d.type==="me"?40:25;'
      +   '}).iterations(3))'
      +   '.force("x",d3.forceX(w/2).strength(0.03))'
      +   '.force("y",d3.forceY(h/2).strength(0.03));'

      // Draw links
      + 'var link=g.append("g").selectAll("line").data(links).enter().append("line")'
      +   '.attr("stroke",function(d){return d.type==="me-repo"?"#4da6ff":d.type==="me-person"?"#a855f7":"#555";})'
      +   '.attr("stroke-width",function(d){return d.type==="person-repo"?Math.max(1,d.w):Math.max(1,d.w);})'
      +   '.attr("stroke-opacity",function(d){return d.type==="person-repo"?0.2:0.4;})'
      +   '.attr("stroke-dasharray",function(d){return d.type==="person-repo"?"3,4":d.type==="me-person"?"5,3":"";});'
      // Invisible wider hit areas for clickable edges
      + 'var linkHit=g.append("g").selectAll("line").data(links).enter().append("line")'
      +   '.attr("stroke","transparent").attr("stroke-width",12).style("cursor","pointer")'
      +   '.on("click",function(ev,d){'
      +     'ev.stopPropagation();'
      +     'if(d.stats){showEdgeDetail(d);}'
      +     'link.attr("stroke-opacity",function(e){return e===d?0.9:0.06;});'
      +   '});'

      // Draw nodes
      + 'var node=g.append("g").selectAll("g").data(nodes).enter().append("g")'
      +   '.call(d3.drag()'
      +     '.on("start",function(e,d){if(!e.active)sim.alphaTarget(0.3).restart();d.fx=d.x;d.fy=d.y;})'
      +     '.on("drag",function(e,d){d.fx=e.x;d.fy=e.y;})'
      +     '.on("end",function(e,d){if(!e.active)sim.alphaTarget(0);if(d.id!=="me"){d.fx=null;d.fy=null;}}));'

      // Me node
      + 'node.filter(function(d){return d.type==="me";})'
      +   '.append("circle").attr("r",28).attr("fill","#00d2d3").attr("fill-opacity",0.2).attr("stroke","#00d2d3").attr("stroke-width",3);'
      + 'node.filter(function(d){return d.type==="me";})'
      +   '.append("text").attr("text-anchor","middle").attr("dominant-baseline","central").attr("font-size","20px").text("\\u{1F464}");'

      // Person nodes
      + 'node.filter(function(d){return d.type==="person";})'
      +   '.append("circle").attr("r",function(d){return Math.max(12,Math.min(22,8+d.act*2));})'
      +   '.attr("fill","#2d333b").attr("stroke","#a855f7").attr("stroke-width",2).attr("fill-opacity",0.2);'
      + 'node.filter(function(d){return d.type==="person";})'
      +   '.append("text").attr("text-anchor","middle").attr("dominant-baseline","central").attr("font-size","12px").text("\\u{1F464}");'

      // Repo nodes (label chip)
      + 'node.filter(function(d){return d.type==="repo";}).each(function(d){'
      +   'var tw=d.label.length*7+36;d.tw=tw;'
      +   'd3.select(this).append("rect").attr("width",tw).attr("height",32).attr("x",-tw/2).attr("y",-16)'
      +     '.attr("fill","#1a1a2e").attr("stroke","#ffa502").attr("stroke-width",2).attr("rx",6);'
      +   'd3.select(this).append("text").attr("x",-tw/2+8).attr("dominant-baseline","central").attr("font-size","11px").text("\\u{1F4C1}");'
      +   'd3.select(this).append("text").attr("x",-tw/2+24).attr("dominant-baseline","central").attr("font-size","11px").attr("fill","var(--text-primary,#ccc)").text(d.label);'
      + '});'

      // Labels (non-repo)
      + 'node.filter(function(d){return d.type!=="repo";}).append("text").attr("class","label")'
      +   '.attr("dy",function(d){return d.type==="me"?40:28;}).text(function(d){return d.label;});'

      // Click → detail + highlight connected links
      + 'node.on("click",function(ev,d){'
      +   'ev.stopPropagation();showDetail(d);'
      +   'link.attr("stroke-opacity",function(e){'
      +     'var sid=typeof e.source==="object"?e.source.id:e.source;'
      +     'var tid=typeof e.target==="object"?e.target.id:e.target;'
      +     'return(sid===d.id||tid===d.id)?0.8:0.04;'
      +   '});'
      + '});'
      + 'svg.on("click",function(){document.getElementById("detail").classList.add("hidden");'
      +   'link.attr("stroke-opacity",function(d){return d.type==="person-repo"?0.2:0.4;});'
      + '});'

      // Detail panel
      + 'function showDetail(d){var el=document.getElementById("detail");el.classList.remove("hidden");var h="";'
      + 'if(d.type==="repo"){'
      +   'var r=d.data;'
      +   'h+="<div class=\\"dn\\">\\u{1F4C1} "+esc(r.name)+"</div><div class=\\"ds\\">Your activity</div>";'
      +   'h+="<div class=\\"dr\\"><span>PRs Authored</span><span class=\\"dv\\">"+r.myPRsCreated+"</span></div>";'
      +   'h+="<div class=\\"dr\\"><span>PRs Reviewed</span><span class=\\"dv\\">"+r.myPRsReviewed+"</span></div>";'
      +   'if(r.myCommits>0)h+="<div class=\\"dr\\"><span>Commits</span><span class=\\"dv\\">"+r.myCommits+"</span></div>";'
      +   'h+="<div class=\\"dr\\"><span>Comments on Your PRs</span><span class=\\"dv\\">"+r.myComments+"</span></div>";'
      +   'if(r.myLinesAdded>0){h+="<div class=\\"dr\\"><span>Lines Added</span><span class=\\"dv\\" style=\\"color:#3fb950\\">+"+fmt(r.myLinesAdded)+"</span></div>";'
      +   'h+="<div class=\\"dr\\"><span>Lines Deleted</span><span class=\\"dv\\" style=\\"color:#f85149\\">-"+fmt(r.myLinesDeleted)+"</span></div>";}'
      +   'h+="<div class=\\"dr\\"><span>Repo Total PRs</span><span class=\\"dv\\">"+r.totalPRs+"</span></div>";'
      +   'h+="<div class=\\"dr\\"><span>Contributors</span><span class=\\"dv\\">"+r.totalContributors+"</span></div>";'
      +   'if(r.lastActivity)h+="<div class=\\"dr\\"><span>Last Activity</span><span class=\\"dv\\">"+esc(r.lastActivity)+"</span></div>";'
      +   'var ft=r.myFileTypes||{};var fk=Object.keys(ft);'
      +   'if(fk.length>0){h+="<div class=\\"dsec\\"><strong>Files You Changed:</strong>";for(var i=0;i<fk.length;i++)h+="<div class=\\"di\\">." +esc(fk[i])+" \\u2014 "+ft[fk[i]]+" files</div>";h+="</div>";}'
      +   'if(r.topReviewersForMe&&r.topReviewersForMe.length>0){h+="<div class=\\"dsec\\"><strong>Your PR Reviewers:</strong>";'
      +   'for(var i=0;i<r.topReviewersForMe.length;i++){var rv=r.topReviewersForMe[i];h+="<div class=\\"di\\">\\u{1F464} "+esc(rv.name)+" \\u2014 "+rv.count+" reviews ("+rv.approveRate+"% approved)</div>";}h+="</div>";}}'
      + 'else if(d.type==="person"){'
      +   'var pe=d.data;'
      +   'h+="<div class=\\"dn\\">\\u{1F464} "+esc(pe.name)+"</div><div class=\\"ds\\">@"+esc(pe.alias)+" \\u00B7 Your collaboration</div>";'
      +   'h+="<div class=\\"dr\\"><span>They Reviewed Your PRs</span><span class=\\"dv\\">"+pe.theyReviewedMyPRs+"</span></div>";'
      +   'h+="<div class=\\"dr\\"><span>You Reviewed Theirs</span><span class=\\"dv\\">"+pe.iReviewedTheirPRs+"</span></div>";'
      +   'h+="<div class=\\"dr\\"><span>Their Comments on Your PRs</span><span class=\\"dv\\">"+pe.theyCommentedOnMyPRs+"</span></div>";'
      +   'var allRepos=pe.contributedRepos||pe.sharedRepos||[];'
      +   'if(allRepos.length>0){h+="<div class=\\"dsec\\"><strong>Repos They Contribute To:</strong>";'
      +   'for(var i=0;i<allRepos.length;i++)h+="<div class=\\"di\\">\\u{1F4C1} "+esc(allRepos[i])+"</div>";h+="</div>";}}'
      + 'else{'
      +   'h+="<div class=\\"dn\\">\\u{1F464} "+esc(p.currentUser)+" <span style=\\"color:var(--color-cyan)\\">(you)</span></div>";'
      +   'h+="<div class=\\"ds\\">@"+esc(p.currentAlias)+"</div>";'
      +   'h+="<div class=\\"dr\\"><span>PRs Authored</span><span class=\\"dv\\">"+p.totalPRsCreated+"</span></div>";'
      +   'h+="<div class=\\"dr\\"><span>PRs Reviewed</span><span class=\\"dv\\">"+p.totalPRsReviewed+"</span></div>";'
      +   'if(p.totalCommits>0)h+="<div class=\\"dr\\"><span>Commits</span><span class=\\"dv\\">"+p.totalCommits+"</span></div>";'
      +   'if(p.totalLinesAdded>0){h+="<div class=\\"dr\\"><span>Lines Added</span><span class=\\"dv\\" style=\\"color:#3fb950\\">+"+fmt(p.totalLinesAdded)+"</span></div>";'
      +   'h+="<div class=\\"dr\\"><span>Lines Deleted</span><span class=\\"dv\\" style=\\"color:#f85149\\">-"+fmt(p.totalLinesDeleted)+"</span></div>";}'
      +   'h+="<div class=\\"dr\\"><span>Repos</span><span class=\\"dv\\">"+p.repos.length+"</span></div>";'
      +   'h+="<div class=\\"dr\\"><span>Collaborators</span><span class=\\"dv\\">"+p.people.length+"</span></div>";'
      + '}'
      + 'document.getElementById("detail-content").innerHTML=h;}'

      // Edge detail
      + 'function showEdgeDetail(d){'
      +   'var el=document.getElementById("detail");el.classList.remove("hidden");'
      +   'var s=d.stats;var h="";'
      +   'if(d.type==="me-repo"){'
      +     'h+="<div class=\\"dn\\">\\u{1F517} You \\u2194 "+esc(d.repoName)+"</div>";'
      +     'h+="<div class=\\"ds\\">Your activity in this repo</div>";'
      +     'h+="<div class=\\"dr\\"><span>PRs Authored</span><span class=\\"dv\\">"+s.prsAuthored+"</span></div>";'
      +     'h+="<div class=\\"dr\\"><span>PRs Reviewed</span><span class=\\"dv\\">"+s.prsReviewed+"</span></div>";'
      +     'if(s.commits)h+="<div class=\\"dr\\"><span>Commits</span><span class=\\"dv\\">"+s.commits+"</span></div>";'
      +     'h+="<div class=\\"dr\\"><span>Comments on Your PRs</span><span class=\\"dv\\">"+s.comments+"</span></div>";'
      +     'if(s.linesAdded)h+="<div class=\\"dr\\"><span>Lines Added</span><span class=\\"dv\\" style=\\"color:#3fb950\\">+"+fmt(s.linesAdded)+"</span></div>";'
      +     'if(s.linesDeleted)h+="<div class=\\"dr\\"><span>Lines Deleted</span><span class=\\"dv\\" style=\\"color:#f85149\\">-"+fmt(s.linesDeleted)+"</span></div>";'
      +   '}else if(d.type==="me-person"){'
      +     'h+="<div class=\\"dn\\">\\u{1F517} You \\u2194 "+esc(d.personName)+"</div>";'
      +     'h+="<div class=\\"ds\\">Your collaboration</div>";'
      +     'h+="<div class=\\"dr\\"><span>They Reviewed Your PRs</span><span class=\\"dv\\">"+s.theyReviewedMine+"</span></div>";'
      +     'h+="<div class=\\"dr\\"><span>You Reviewed Theirs</span><span class=\\"dv\\">"+s.iReviewedTheirs+"</span></div>";'
      +     'h+="<div class=\\"dr\\"><span>Their Comments</span><span class=\\"dv\\">"+s.theirComments+"</span></div>";'
      +     'h+="<div class=\\"dr\\"><span>Your Comments</span><span class=\\"dv\\">"+s.myComments+"</span></div>";'
      +     'h+="<div class=\\"dr\\"><span>Shared Repos</span><span class=\\"dv\\">"+s.sharedRepos+"</span></div>";'
      +   '}else{'
      +     'h+="<div class=\\"dn\\">\\u{1F517} "+esc(d.personName)+" \\u2194 "+esc(d.repoName)+"</div>";'
      +     'h+="<div class=\\"ds\\">Contribution to this repo</div>";'
      +     'h+="<div class=\\"dr\\"><span>PRs Authored</span><span class=\\"dv\\">"+s.prsAuthored+"</span></div>";'
      +     'h+="<div class=\\"dr\\"><span>PRs Reviewed</span><span class=\\"dv\\">"+s.prsReviewed+"</span></div>";'
      +     'if(s.linesAdded>0)h+="<div class=\\"dr\\"><span>Code Written</span><span class=\\"dv\\" style=\\"color:#3fb950\\">+"+fmt(s.linesAdded)+"</span></div>";'
      +     'if(s.linesDeleted>0)h+="<div class=\\"dr\\"><span>Code Removed</span><span class=\\"dv\\" style=\\"color:#f85149\\">-"+fmt(s.linesDeleted)+"</span></div>";'
      +     'h+="<div class=\\"dr\\"><span>Comments</span><span class=\\"dv\\">"+(s.comments||0)+"</span></div>";'
      +     'h+="<div class=\\"dr\\"><span>Total Activity</span><span class=\\"dv\\">"+(s.prsAuthored+s.prsReviewed+(s.comments||0))+"</span></div>";'
      +   '}'
      +   'document.getElementById("detail-content").innerHTML=h;'
      + '}'

      // Helpers
      + 'function esc(s){var d=document.createElement("span");d.textContent=s||"";return d.innerHTML;}'
      + 'document.getElementById("close-detail").addEventListener("click",function(){'
      +   'document.getElementById("detail").classList.add("hidden");'
      +   'link.attr("stroke-opacity",function(d){return d.type==="person-repo"?0.2:0.4;});'
      + '});'

      // Tick
      + 'sim.on("tick",function(){'
      +   'link.attr("x1",function(d){return d.source.x;}).attr("y1",function(d){return d.source.y;})'
      +     '.attr("x2",function(d){return d.target.x;}).attr("y2",function(d){return d.target.y;});'
      +   'linkHit.attr("x1",function(d){return d.source.x;}).attr("y1",function(d){return d.source.y;})'
      +     '.attr("x2",function(d){return d.target.x;}).attr("y2",function(d){return d.target.y;});'
      +   'node.attr("transform",function(d){return "translate("+d.x+","+d.y+")";});'
      + '});'

      // Refresh button
      + 'var rb=document.getElementById("refresh-btn");'
      + 'if(rb){var vsc=acquireVsCodeApi();rb.addEventListener("click",function(){'
      +   'rb.classList.add("loading");rb.textContent="\\u{23F3} Refreshing...";'
      +   'vsc.postMessage({command:"refresh"});'
      + '});}'

      + '})();';
  }
}
