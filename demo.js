/*
    mbitcoinjs-lib tester
*/
    var testNet = true;
    var defaultFee = '0.00001';
    var hrefs = {
      tx: 'https://btc.blockr.io/tx/info/',
      addr: 'http://btc.blockr.io/address/info/'
    }
    var hrefs_testnet = {
      tx: "https://tbtc.blockr.io/tx/info/",
      addr: "https://tbtc.blockr.io/address/info/"
    }

    var key1 = null;
    var addr1 = null;
    var escrowKeys = null;
    var wallet1 = null;
    var wallet2 = null;
    var syncNeeded = false;
    var demoKey = '5J4vkjzRBeKztsWXQjgJ9v8iRepDWxAPqX69SnPmAJDD5Ujq5Vr';

    function create1( pass ) { 
      key1 = [createKey( '1', '', pass )];
      wallet1 = createWallet( '1', [key1[0].ecKey] );
      if (key1[0].pass)
        id2el('s1_pass').value = key1[0].pass;
    }
    function sync1( re ) {syncWallet( '1', wallet1, key1, (!re && wallet2)?sync4:null );}

    function do2() { escrowKeys = createKeys( '2' ); }

    function do3() { sendTx( '3', wallet1, escrowKeys, id2el('s3_val').value ); }

    function create4( ) { 
      if (!escrowKeys)
        do2();
      wallet2 = createWallet( '4', [escrowKeys[2].ecKey, escrowKeys[0].ecKey] );
    }
    function sync4( re ) {syncWallet( '4', wallet2, escrowKeys, (!re && wallet1)?sync1:null );}

    function do5() { sendTx( '5', wallet2, key1 ); }



/*
    create key pairs
*/
    function showKey( sn, un, key ) {
      se( sn, un+'addr', fmtaddr(key.addressStr) );
      se( sn, un+'addrtestnet', fmtaddr(key.addressStr,true) );
      se( sn, un+'key', key.privateStr );
    }
    function createKey( sn, un, keyin ) {
      var ki = Bitcoin.Address.fromPrivOrPass( keyin, key_to_english );
      showKey( sn, un, ki );
      return ki;
    }
    function createKeys( sn ) {
      var ki = [];
      ki[0] = createKey( sn, '1_' );
      ki[1] = createKey( sn, '2_' );
      ki[2] = createKey( sn, '3_' );
      return ki;
    }
    function getKeyAddrs( ki ) {
      var addrs = [];
      for( var i=0; i<ki.length; i++ )
        addrs.push( ki[i].addressStr );
      return addrs;
    }
    function getKeyPubs( ki ) {
      var pubs = [];
      for( var i=0; i<ki.length; i++ )
        pubs.push( ki[i].pubHex );
      return pubs;
    }
    function getKeyECs( ki ) {
      var Ecs = [];
      for( var i=0; i<ki.length; i++ )
        Ecs.push( ki[i].ecKey );
      return Ecs;
    }


/*
    create a wallet containing keys
*/
    function createWallet( sn, keys ) {
      if (!keys)
        return se( sn, 'stat', "Create key(s) first" );
      var w = new Bitcoin.Wallet();
      w.addKeys( keys );
      se( sn, 'stat', "" );
      return w;
    }


/*
    sync a wallet to network
*/
    function syncWallet( sn, w, keys, onok ) {
      if (!w)
        return se( sn, 'stat', "Create wallet first" );
      /*
        sync to the network (download and add txs to wallet)
      */
      var n = '';
      function showres( ) {
        syncNeeded = false;
        var a = Bitcoin.Util.formatValue2( w.selectOutputs().avail );
        se( sn, 'avail', a );
        se( sn, 'stat', (w.txCount?w.txCount:0) + " transactions, " + 
                        (w.unspentOuts?w.unspentOuts.length:0) + " unspent outputs" );
        if (onok) onok( true );
      }
      var callbacks = {
        oncomplete: function() {showres();},
        onerror: function(e) {se(sn,'avail',""), se(sn,'stat',e);},
        onprogress: function() {n+='.';se(sn,'stat',"Syncing."+n );}
      }
      var unccallbacks = {
        onprogress: function() {callbacks.onprogress();},
        onerror: function( e ) {callbacks.onerror(e);},
        oncomplete: function( x, unc ) {
          if (!unc)
            Bitcoin.ImpExp.Sync.loadAddrs( w, callbacks, null, testNet );
          else
            callbacks.onerror( "Unconfirmed transactions, wait to resync" );
        }
      }
      syncNeeded = true;
      Bitcoin.ImpExp.Sync.testUnconfirmed( unccallbacks, getKeyAddrs(keys), testNet );
      return w;
    }


/*
    build and send a transaction
*/
    function sendTx( sn, w, toKeys, val ) {
      se( sn, 'txhash', "" );
      if (!w || !key1)
        return se( sn, 'stat', "Create wallet first" );
      if (!toKeys)
        return se( sn, 'stat', "Create keys first" );
      if (syncNeeded)
        return se( sn, 'stat', "Resync needed" );
      /*
        determine amt to spend
      */
      var fee = Bitcoin.Util.parseValue2( defaultFee );
      var avail = w.selectOutputs().avail;
      if (val)
        val = Bitcoin.Util.parseValue2( val );
      else
        val = avail.subtract( fee );
      var t = val.add( fee );
      if (avail.compareTo(BigInteger.ZERO) <= 0)
        return se( sn, 'stat', "No balance (wallet synced?)" );
      if (t.compareTo(avail) > 0)
        return se( sn, 'stat', "Insufficient funds" );
      /*
        build output def (spend everything)
      */
      var out = { value:val };
      if (toKeys.length == 1)
        out.Address = toKeys[0].addressStr;
      else {
        out.Multisig = { M:2 };
        out.Multisig.pubkeys = getKeyPubs( toKeys );
      }
      /*
        create and send tx
      */
      var chgto = { Address:key1[0].addressStr };
      var tx = w.createSend2( [out], chgto, fee );
      if (!tx)
        return se( sn, 'stat', "Couldn't create transaction" );
      var json = Bitcoin.ImpExp.BBE.exportTx( tx, true ).JSON;
      var txhash = JSON.parse(json).hash;
      se( sn, 'txhash', fmttxhash(txhash) );
      id2el( 'pushtx_JSON' ).innerHTML = json;
      /*
        broadcast the tx to the network
      */
      var callbacks = {
        oncomplete: function() {se( sn, 'stat', "Transaction sent" ); syncNeeded=true;},
        onerror: function(e) {se( sn, 'stat', e );}
      }
      se( sn, 'stat', "Sending transaction..." );
      tx = Crypto.util.bytesToHex( tx.serialize() );
      Bitcoin.ImpExp.Sync.sendNewTx( w, callbacks, tx, 
                                     id2el('pushtx_form'), id2el('pushtx_hex'), testNet );
    }



/*
    funs for helping with results display
*/
    function id2el( id ) {return document.getElementById( id ); }
    function se( sn, id, v ) {
      var e = id2el( 's' + sn + '_' + id );
      e.innerHTML = v;
      e = id2el( 's' + sn + '_stat' );
      if (e)
        e.innerHTML = id == 'stat' ? v : "";
      e = id2el( 's' + sn + '_toggle' );
      e.style.display = "block";
    }
    function fmtaddr( a, showtestnet ) {
      if (!a)
        return "";
      var ba = a;
      var ta = Bitcoin.ImpExp.Sync.fmtAddr( a, true );
      if (showtestnet)
        a = ta;
      var href = (testNet ? hrefs_testnet.addr : hrefs.addr) + (testNet ? ta : ba);
      return "<a href='" + href + "' target=_blank>" + 
                  a.toString() + 
             "</a>";
    }
    function fmttxhash( h ) {
      //h = Bitcoin.ImpExp.BBE.exportHash( h );
      var href = (testNet ? hrefs_testnet.tx : hrefs.tx) + h;
      return "<a href='" + href + "' target=_blank>" + 
               h + 
             "</a>";
    }



