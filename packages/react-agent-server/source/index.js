import { log } from 'util';

require('babel-polyfill');

module.exports = (server, actions, database, logger = false) => {

  const socketio = require('socket.io');
  const io = socketio(server);
  const chalk = require('chalk');
  let sequelize;
  let offlineCache = {};

  if (database) {
    const Sequelize = require('sequelize');
    const { Op } = Sequelize;
    sequelize = new Sequelize(database.name, database.user, database.password, {
      dialect: database.dialect,
      host: database.host,
      port: database.port,
      operatorsAliases: Op,
      logging: logger === true ? action => console.log(' ', action) : false,
    });
  }

  const subscribedSockets = {};

  // Precaution for offline cache:
  // If an action with the same UUID has already been run
  // in the last three seconds, then the action will not be run again.
  // For example: 1) the client deletes the most recent comment and the actions runs on the server.
  // 2) the client does not receive the response because the network disconnects.
  // 3) once the network reconnects, React Agent tries to run the action again (delete the most recent user), which would be a mistake.
  // While steps #1-3 could be a feature, not a bug, this is a compromise approach
  // since the cache is deleted from memory every three seconds.
  setInterval(() => {
    offlineCache = {};
  }, 3000);

  const runAction = (key, request, actionId, socketID, callback) => {
    // Takes in msg and the logger parameter to console log the associated error if not false
    // or call the logger function on the error text if logger is a function.
    const logHelper = (msg, etc) => {
      // For checking if action does not exist in actions object
      if (msg === 'actionKey' && typeof logger !== 'function') {
        console.log(chalk.bold.green('Key: '), chalk.bold.blue(key), 'not found');
      }
      if (msg === 'actionKey' && typeof logger === 'function') {
        logger('Key: ' + key + ' not found');
      }
      // After checking socketId and actionId in offline cache
      if (msg === 'keyId' && typeof logger !== 'function') {
        if (request) console.log(chalk.bold.green('Key: '), chalk.bold.blue(key), chalk.bold.green('\nID:'), chalk.blue(actionId), '\n', chalk.bold(' From client: '), request);
        else console.log(chalk.bold.green('Key: '), chalk.bold.blue(key), chalk.bold.blue('\nID:'), chalk.blue(actionId));
      }
      if (msg === 'keyId' && typeof logger === 'function') {
        if (request) logger('Key: ' + key + 'ID:' + actionId);
        if (request) logger('  From client: ' + JSON.stringify(request));
        else logger('Key: ' + key + 'ID:' + actionId);
      }
      // Not all pre functions passed
      if (msg === 'preErrorMulti') {
        if (typeof logger !== 'function') console.log(chalk.bold.red(`  Pre-error: did not pass function #${etc + 1}`));
        if (typeof logger === 'function') logger(`  Pre-error: did not pass function #${etc + 1}`);
      }
      // PreError without looping with i
      if (msg === 'preErrorSingle') {
        if (typeof logger !== 'function') console.log(chalk.bold.red(`  Pre-error: did not pass pre function`));
        if (typeof logger === 'function') logger(`  Pre-error: did not pass pre function`);
      }
      // All pre functions evaluated to true
      if (msg === 'passAll') {
        if (typeof logger !== 'function' && actions[key].pre) console.log(chalk.bold('  Pre: '), 'Passed all function(s)');
        if (typeof logger === 'function' && actions[key].pre) logger('  Pre: ' + 'Passed all function(s)');
      }
      // Database Error
      if (msg === 'databaseError') {
        if (typeof logger !== 'function') console.log(chalk.bold.red('  Error with database: '), chalk.yellow(etc));
        if (typeof logger === 'function') logger('  Error with database: ' + etc);
      }
      // Log if promise related to action resolves
      if (msg === 'actionResolve') {
        if (typeof logger !== 'function') console.log(chalk.bold('  Action function: '), 'resolved');
        if (typeof logger === 'function') logger('  Action function: resolved');  
      }
      // Log if promise related to action rejected
      if (msg === 'actionReject') {
        if (typeof logger !== 'function') console.log(chalk.bold.red('  Action function: '), 'rejected');
        if (typeof logger === 'function') logger('  Action function: rejected');
      }
    };

    // if key in actions does not exist return error
    if (!actions[key]) {
      if (logger) logHelper('actionKey');
      return callback({ key, keyError: 'React Agent: Key not found in actions', actionId });
    }

    if (!offlineCache[socketID] || !offlineCache[socketID][actionId]) {
      if (offlineCache[socketID]) offlineCache[socketID][actionId] = 0;
      else offlineCache[socketID] = { [actionId]: 0 };
      if (logger) logHelper('keyId');
     
      if (actions[key].pre) {
        if (Array.isArray(actions[key].pre)) {
          for (let i = 0; i < actions[key].pre.length; i++) {
            const returned = actions[key].pre[i](request);
            if (returned === false) {
              if (logger) logHelper('preErrorMulti', i);
              return callback({ key, preError: 'React Agent: Not all server pre functions passed.', actionId });
            }
            request = returned;
          }
        } else {
          const returned = actions[key].pre(request);
          if (returned === false) {
            if (logger) logHelper('preErrorSingle');
            return callback({ key, preError: 'React Agent: Not all server pre functions passed.', actionId });
          }
          request = returned;
        }
      }

      if (logger) logHelper('passAll');

      if (typeof actions[key].action !== 'function') {
        sequelize.query(actions[key].action, { replacements: request })
          .then((response) => {
            if (actions[key].callback) {
              callback({ key, response: actions[key].callback(response), actionId });
            } else {
              callback({ key, response, actionId });
            }
          })
          .catch((error) => {
            if (logger) logHelper('databaseError', error); 
            if (actions[key].errorMessage) {
              callback({ key, databaseError: actions[key].errorMessage, actionId });
            } else {
              callback({ key, databaseError: 'Error with database', actionId });
            }
          });
      } else {
        const promise = new Promise((resolve, reject) => {
          actions[key].action(resolve, reject, request);
        });
        promise.then((response) => {
          if (logger) logHelper('actionResolve');
          callback({ key, response, actionId });
        }).catch(error => {
          if (logger) logHelper('actionReject');
          callback({ key, actionError: `The action for ${key} rejected its promise.`, actionId })
        });
      }
    } 
  };

  io.on('connection', (socket) => {

    socket.on('subscribe', ({ key, actionId }) => {
      socket.emit('emitOnUnsubscribeResponse', { actionId });
      if (subscribedSockets[key]) {
        if (!subscribedSockets[key].includes(socket)) {
          subscribedSockets[key].push(socket);
        }
      } else subscribedSockets[key] = [socket];
    });

    socket.on('unsubscribe', ({ key, actionId }) => {
      socket.emit('emitOnUnsubscribeResponse', { actionId });
      if (subscribedSockets[key] && subscribedSockets[key].includes(socket)) {
        const i = subscribedSockets[key].indexOf(socket);
        if (i > -1) {
          const arr = subscribedSockets[key].slice();
          arr.splice(i, 1);
          subscribedSockets[key] = arr;
        }
      }
    });

    socket.on('emit', (data) => {
      if (subscribedSockets[data.key]) {
        runAction(data.key, data.request, data.actionId, data.socketID, (result) => {
          socket.emit('emitOnUnsubscribeResponse', { actionId: data.actionId });
          subscribedSockets[data.key].forEach((subSocket) => {
            subSocket.emit('subscriber', result);
          });
        });
      }
    });

    socket.on('run', (data) => {
      let response = {}, finished = 0;
      data.keys.forEach(key => {
        runAction(key, data.request, data.actionId, data.socketID, result => {
          finished++;
          response[result.key] = result;
          if (logger && typeof logger !== 'function') console.log(chalk.bold('  Completed: '), key, data.actionId);
          if (logger && typeof logger === 'function') logger('  Completed: ' + key + data.actionId);
          if (finished === data.keys.length) {
            if (data.keys.length === 1) response = response[data.keys[0]];
            socket.emit('response', response);
          }
        });
      });
    });

    // Search through each key in subscribedSockets object and look for matching socket
    // Remove matching socket from each of the arrays corresponding to the key
    socket.on('disconnect', () => {
      Object.keys(subscribedSockets).forEach((key) => {
        const i = subscribedSockets[key].indexOf(socket);
        if (i > -1) {
          const arr = subscribedSockets[key].slice();
          arr.splice(i, 1);
          subscribedSockets[key] = arr;
        }
      });
    });
  });
}
