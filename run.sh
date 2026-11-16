#!/usr/bin/env bash
# cursor-swarm launcher: ./run.sh start|stop|status
cd "$(dirname "$0")" || exit 1
PORT=${PORT:-8981}; PIDFILE=.server.pid; LOG=.server.log
running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
case "${1:-start}" in
  start)  running && { echo "already running: http://127.0.0.1:$PORT"; exit 0; }
          PORT=$PORT nohup node server.mjs >"$LOG" 2>&1 & echo $! >"$PIDFILE"
          echo "http://127.0.0.1:$PORT" ;;
  stop)   running && kill "$(cat "$PIDFILE")"; rm -f "$PIDFILE"; echo stopped ;;
  status) running && echo "running: http://127.0.0.1:$PORT" || echo stopped ;;
  *)      echo "usage: $0 start|stop|status"; exit 2 ;;
esac
