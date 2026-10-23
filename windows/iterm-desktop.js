module.exports = process.env.AGENT_DECK_DESKTOP_SOCKET
  ? require('./desktop-bridge')
  : require('./tmux-controller');
