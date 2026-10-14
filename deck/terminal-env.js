const env={...process.env,PATH:require('./paths').binPath,AGENTDECK_SUPPRESS_TMUX_WARNING:'1',AGENT_DECK_ALLOW_OUTER_TMUX:'1',LANG:'en_US.UTF-8',LC_CTYPE:'en_US.UTF-8',LC_ALL:'en_US.UTF-8',COLORTERM:'truecolor',FORCE_COLOR:'3'};
for(const name of ['NO_COLOR','NODE_DISABLE_COLORS','CODEX_CI','CI','TMUX','AI_AGENT'])delete env[name];
// A deck started from inside a Claude chat must not hand that chat's login and
// session to the agents it launches; each account sets its own folder.
for(const name of Object.keys(env))if(/^(CLAUDE|ANTHROPIC_)/.test(name))delete env[name];
if(!env.TERM||env.TERM==='dumb')env.TERM='xterm-256color';
env.AGENTDECK_ACCOUNT_LABELS=JSON.stringify(Object.fromEntries(require('./account-registry').accounts.map(a=>[a.slot,{name:a.tag,color:'#'+a.color.split(';').map(n=>Number(n).toString(16).padStart(2,'0')).join('')}])));
module.exports=env;
