// pino's browser build has no typings of its own; it shares the main pino API.
declare module 'pino/browser.js' {
  import pino from 'pino'
  export default pino
}
