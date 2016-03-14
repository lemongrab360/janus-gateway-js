var assert = require('chai').assert;
var sinon = require('sinon');
var _ = require('underscore');
var Promise = require('bluebird');
var JanusError = require('../src/error');
var Connection = require('../src/connection');
var Session = require('../src/session');
var Plugin = require('../src/plugin');

describe('Session tests', function() {

  context('basic operations', function() {
    var connection, session;

    beforeEach(function() {
      connection = new Connection('connection-id', {address: 'address'});
      session = new Session(connection, 'id');
    });

    it('is created correctly', function() {
      assert.equal(session.getId(), 'id');
      assert.strictEqual(session._connection, connection);
    });

    it('is destroyed on connection.close', function(done) {
      sinon.spy(session, '_destroy');
      session.on('destroy', function() {
        assert.isTrue(session._destroy.calledOnce);
        done();
      });
      connection.close();
    });

    it('adds transaction', function(done) {
      var transactionToAdd = {id: 'id'};
      sinon.stub(session.getTransactions(), 'add', function(transaction) {
        assert.equal(transaction, transactionToAdd);
        done();
      });
      session.addTransaction(transactionToAdd);
    });

    it('sends message with session_id', function() {
      var message;
      sinon.stub(session._connection, 'send');

      message = {};
      session.send(message);
      assert.equal(message.session_id, session.getId());
      assert.isTrue(session._connection.send.calledOnce);
      assert.strictEqual(session._connection.send.getCall(0).args[0], message);

      message = {session_id: session.getId() + 'bla'};
      session.send(message);
      assert.equal(message.session_id, session.getId());
    });

    it('attachPlugin sends correct message', function(done) {
      sinon.stub(session, 'send', function(message) {
        assert.equal(message.janus, 'attach');
        assert.equal(message.plugin, 'plugin');
        done();
      });
      session.attachPlugin('plugin');
    });

    it('destroy sends correct message', function(done) {
      sinon.stub(session, 'send', function(message) {
        assert.equal(message.janus, 'destroy');
        done();
      });
      session.destroy();
    });

  });

  context('keepalive works', function() {
    var connection, session, keepAlivePeriod = 500;

    beforeEach(function() {
      connection = new Connection('connection-id', {address: 'address', keepalive: keepAlivePeriod});
      session = new Session(connection, 'id');
      sinon.spy(session, 'send');
      sinon.stub(session._connection, 'sendSync');
    });

    it('is sent periodically when session is inactive', function(done) {
      assert.equal(session.send.callCount, 0);
      _.delay(function() {
        assert.equal(session.send.callCount, 2);

        assert.equal(session.send.getCall(0).args[0]['janus'], 'keepalive');
        assert.equal(session.send.getCall(1).args[0]['janus'], 'keepalive');
        done();
      }, 2 * keepAlivePeriod + 10);
    });

    it('is reset after any message is sent', function(done) {
      var halfPeriod = keepAlivePeriod / 2;
      _.delay(function() {
        session.send({});
      }, halfPeriod);
      _.delay(function() {
        assert.equal(session.send.callCount, 1);
        assert.isUndefined(session.send.getCall(0).args[0]['janus']);
      }, keepAlivePeriod + 10);
      _.delay(function() {
        assert.equal(session.send.callCount, 2);
        assert.equal(session.send.getCall(1).args[0]['janus'], 'keepalive');
        done();
      }, keepAlivePeriod + halfPeriod + 10);
    });

    it('stops on destroy', function() {
      var stopSpy = sinon.spy(session._keepAliveTimer, 'stop');
      session._destroy();
      assert.isTrue(stopSpy.calledOnce);
    });
  });

  context('CRUD with plugins', function() {

    var session, plugin;

    beforeEach(function() {
      session = new Session(new Connection('id', {address: 'address'}), 'id');
      plugin = new Plugin(session, 'name', 'id');
    });

    it('add plugin', function() {
      assert.isFalse(session.hasPlugin(plugin.getId()));
      session.addPlugin(plugin);
      assert.isTrue(session.hasPlugin(plugin.getId()));
      assert.strictEqual(session.getPlugin(plugin.getId()), plugin);
    });

    it('remove plugin', function() {
      session.addPlugin(plugin);
      session.removePlugin(plugin.getId());
      assert.isFalse(session.hasPlugin(plugin.getId()));
      assert.isUndefined(session.getPlugin(plugin.getId()));
    });

  });

  context('processIncomeMessage check', function() {
    var session;

    beforeEach(function() {
      session = new Session(new Connection('id', {address: 'address'}), 'id');
    });

    it('calls _onTimeout for timeout message', function() {
      sinon.stub(session, '_onTimeout');
      var message = {janus: 'timeout'};
      session.processIncomeMessage(message);
      assert.isTrue(session._onTimeout.calledOnce);
      assert.equal(session._onTimeout.getCall(0).args[0], message);
    });

    context('delegates plugin messages to plugin', function() {
      var plugin;

      beforeEach(function() {
        plugin = new Plugin(session, 'name', 'id');
        session.addPlugin(plugin);
      });

      it('resolves for existing plugin', function(done) {
        var messageToProcess = {handle_id: plugin.getId()};
        sinon.stub(plugin, 'processIncomeMessage')
          .withArgs(messageToProcess)
          .returns(Promise.resolve('processed by plugin'));

        session.processIncomeMessage(messageToProcess)
          .then(function(result) {
            assert.equal(result, 'processed by plugin');
            done();
          })
          .catch(done);
      });

      it('rejects for non existing plugin', function(done) {
        var messageToProcess = {sender: 'unknown'};
        session.processIncomeMessage(messageToProcess)
          .then(function() {
            done(new Error('income message should not be processed by plugin'));
          })
          .catch(function(error) {
            assert.match(error.message, /invalid plugin/i);
            done();
          });
      });

    });

  });

  context('processOutcomeMessage', function() {
    var session;

    beforeEach(function() {
      session = new Session(new Connection('id', {address: 'address'}), 'id');
    });

    it('calls _onAttach for attach message', function() {
      sinon.stub(session, '_onAttach');
      var message = {janus: 'attach'};
      session.processOutcomeMessage(message);
      assert.isTrue(session._onAttach.calledOnce);
      assert.equal(session._onAttach.getCall(0).args[0], message);
    });

    it('calls _onDestroy for destroy message', function() {
      sinon.stub(session, '_onDestroy');
      var message = {janus: 'destroy'};
      session.processOutcomeMessage(message);
      assert.isTrue(session._onDestroy.calledOnce);
      assert.equal(session._onDestroy.getCall(0).args[0], message);
    });

    context('delegates plugin messages to plugin', function() {
      var plugin;

      beforeEach(function() {
        plugin = new Plugin(session, 'name', 'id');
        session.addPlugin(plugin);
      });

      it('delegates for existing plugin', function(done) {
        var messageToProcess = {handle_id: plugin.getId()};
        sinon.stub(plugin, 'processOutcomeMessage')
          .withArgs(messageToProcess)
          .returns(Promise.resolve('processed by plugin'));

        session.processOutcomeMessage(messageToProcess)
          .then(function(result) {
            assert.equal(result, 'processed by plugin');
            done();
          })
          .catch(done);
      });

      it('rejects for non existing session', function(done) {
        var messageToProcess = {handle_id: 'unknown'};
        session.processOutcomeMessage(messageToProcess)
          .then(function() {
            done(new Error('income message should not be processed by plugin'));
          })
          .catch(function(error) {
            assert.match(error.message, /invalid plugin/i);
            done();
          });
      });

    });

  });

  context('`_on` message callbacks', function() {
    var session;

    beforeEach(function() {
      session = new Session(new Connection('id', {address: 'address'}), 'id');
      sinon.stub(session, 'send');
      sinon.stub(session, 'addTransaction');
    });

    it('_onTimeout calls destroy', function() {
      sinon.spy(session, '_destroy');
      session._onTimeout({});
      assert.isTrue(session._destroy.calledOnce);
    });

    context('_onAttach plugin', function() {

      var message, transaction;

      beforeEach(function() {
        session.attachPlugin('plugin');
        message = session.send.getCall(0).args[0];
        message.transaction = 'transaction';
        session.processOutcomeMessage(message);
        transaction = session.addTransaction.getCall(0).args[0];
      });

      it('add transaction if processed', function() {
        assert.isTrue(session.addTransaction.calledOnce);
        assert.equal(transaction.id, message.transaction);
      });

      it('return Plugin on success janus response', function(done) {
        transaction.execute({janus: 'success', data: {id: 'plugin-id'}})
          .then(function(plugin) {
            assert.equal(plugin.getId(), 'plugin-id');
            assert.equal(plugin._name, 'plugin');
            done();
          })
          .catch(done);
      });

      it('return Error on error janus response', function(done) {
        //catch error duplication
        transaction.promise.catch(_.noop);

        transaction.execute({janus: 'error'})
          .then(function() {
            done(new Error('Plugin attach must be rejected'));
          })
          .catch(function(error) {
            assert.instanceOf(error, JanusError.Error);
            done();
          });
      });
    });

    context('_onDestroy', function() {
      var message, transaction;

      beforeEach(function() {
        session.destroy();
        message = session.send.getCall(0).args[0];
        message.transaction = 'transaction';
        session.processOutcomeMessage(message);
        transaction = session.addTransaction.getCall(0).args[0];
      });

      it('add transaction if processed', function() {
        assert.isTrue(session.addTransaction.calledOnce);
        assert.equal(transaction.id, message.transaction);
      });

      it('destroys on success janus response', function(done) {
        sinon.stub(session, '_destroy').returns(Promise.resolve());
        transaction.execute({janus: 'success'})
          .then(function() {
            assert.isTrue(session._destroy.calledOnce);
            done();
          })
          .catch(done);
      });

      it('return Error on error janus response', function(done) {
        //catch error duplication
        transaction.promise.catch(_.noop);

        sinon.stub(session, '_destroy');
        transaction.execute({janus: 'error'})
          .then(function() {
            done(new Error('Session destroy must be rejected'));
          })
          .catch(function(error) {
            assert.instanceOf(error, JanusError.Error);
            assert.isFalse(session._destroy.called);
            done();
          });
      });
    });

  });

});
