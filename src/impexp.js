//
//Importer/exporter for bitcoin transaction data in various formats;
//  builds wallet from imported data (public domain)
//
//BlockExplorer/BlockChain/Blockr data import (adapted from BrainWallet)
//
//  status = Bitcoin.ImpExp.import( textJSON, wallet )
//    status: {txsRejected:<>,txsAccepted:<>,err:<extracted error message>}
//    auto-detects whether BCI-unspents, BBE, or BIO data
//          (see bottom of file for examples of each)
//
//  status = Bitcoin.ImpExp.BBE.export( wallet )
//    status: {text:<JSON>,txsRejected:<>,txsAccepted:<>}
//
//  Bitcoin.ImpExp.Sync.loadAddrs( wallet, callbacks, addresses, testnet )
//  Bitcoin.ImpExp.Sync.loadTxs( wallet, callbacks, txs, testnet )
//    connects to server (default BIO) and loads data into wallet
//
//
Bitcoin.ImpExp = {BCI:{},BBE:{},BIO:{}};
Bitcoin.ImpExp.BCI.unspentsURL = "http://blockchain.info/unspent?address=";
//
Bitcoin.ImpExp.BBE.addrURL = 'http://blockexplorer.com/q/mytransactions/';
Bitcoin.ImpExp.BBE.txURL = 'http://blockexplorer.com/rawtx/';
Bitcoin.ImpExp.BBE.txURL_testnet = 'http://blockexplorer.com/testnet/rawtx/';
//
//  (as of this writing, Blockr.io has the most complete APIs;
//   they are also not impeded by CORS restrictions)
//
Bitcoin.ImpExp.BIO.addrURL =         'https://btc.blockr.io/api/v1/address/txs/';
Bitcoin.ImpExp.BIO.addrURL_testnet = 'https://tbtc.blockr.io/api/v1/address/txs/';
Bitcoin.ImpExp.BIO.uncaddrURL =         'https://btc.blockr.io/api/v1/address/unconfirmed/';
Bitcoin.ImpExp.BIO.uncaddrURL_testnet = 'http://tbtc.blockr.io/api/v1/address/unconfirmed/';
Bitcoin.ImpExp.BIO.txURL =         'http://btc.blockr.io/api/v1/tx/raw/';
Bitcoin.ImpExp.BIO.txURL_testnet = 'http://tbtc.blockr.io/api/v1/tx/raw/';
Bitcoin.ImpExp.BIO.sendURL =         'https://btc.blockr.io/api/v1/tx/push';
Bitcoin.ImpExp.BIO.sendURL_testnet = 'https://tbtc.blockr.io/api/v1/tx/push';


Bitcoin.ImpExp.Processor = function( imp, exp, onProgress, strict ) {
  this.importNextTx = imp;
  this.exportNextTx = exp;
  this.onProgress = onProgress;
  this.relaxedValidation = !strict;
}

Bitcoin.ImpExp.Processor.prototype.importAll = function( text, wallet ) {
  var r = {txsRejected:0,txsAccepted:0};
  if (!wallet)
    return r;
  if (!text) {
    wallet.reprocess();
    return r;
  }
  do {
    if (this.onProgress)
      this.onProgress( r.txsAccepted+r.txsRejected );
    r.res = this.importNextTx( text, wallet, this );
    if (!r.res.allinvalid && !r.res.complete)
      r.res.tx ? r.txsAccepted++ : r.txsRejected++;
    if (this.err) r.err = this.err;
  }
  while( !r.err && !r.res.allinvalid && !r.res.complete );
  if (r.res.allinvalid)
    r.err = "Transaction data invalid (parse failed)";
  wallet.reprocess();
  return r;
}

Bitcoin.ImpExp.Processor.prototype.addTx = function( tx, wallet ) {
  var newtx = Bitcoin.Transaction.prepForWallet( 
                                     tx, false, this.relaxedValidation );
  wallet.txIndex[newtx.hash] = newtx;
  return newtx;
}

Bitcoin.ImpExp.Processor.prototype.exportAll = function( wallet ) {
  if (!wallet)
    return null;
  var tx, accepts=0, rejects=0;
  this.text = "{}";
  for( var txhash in wallet.txIndex )
    if (this.exportNextTx( wallet.txIndex[txhash], this ))
      accepts++;
    else
      rejects++;
  return {text:this.text,txsRejected:rejects,txsAccepted:accepts};
}


/*
BlockExplorer/BlockChain/Blockr.io import implementation
  (data from BCI or BIO is restructured to be compatible with BBE)
*/

Bitcoin.ImpExp.BBE.importHash = function( hash ) {
  function endian(string) {
    var out = [];
    for( var i=string.length; i>0; i-=2 ) {
      out.push( string.substring(i-2,i) );
    }
    return out.join("");
  }
  var lehash = endian( hash );
  return Crypto.util.bytesToBase64( Crypto.util.hexToBytes(lehash) );
}

Bitcoin.ImpExp.BBE.importScript = function( script ) {
  var newScript = new Bitcoin.Script();
  var s = script ? script.split( " " ) : {};
  for (var i in s)
    if (Bitcoin.Opcode.map.hasOwnProperty( s[i] ))
      newScript.writeOp( Bitcoin.Opcode.map[s[i]] );
    else {
      var taken = false;
      if (s[i].length <= 2) {
        //  look for small b10 (such as m or n in multisig)
        var n = new Number( s[i] );
        if (n <= 16 && n >= 0 && n.toString() == s[i]) {
          if (s[i] == '0')
            newScript.writeOp( Bitcoin.Opcode.map['OP_0'] );
          else
            newScript.writeOp( Bitcoin.Opcode.map['OP_1']+n-1 );
          taken = true;
        }
      }
      if (!taken) {  //(its probably a sig, pubkey, addr, etc.)
        var h = Crypto.util.hexToBytes( s[i] );
        newScript.writeBytes( h );
      }
    }
  return newScript;
}

Bitcoin.ImpExp.BCI.importScript = function( script ) {
  return new Bitcoin.Script( Crypto.util.hexToBytes(script) );
}

Bitcoin.ImpExp.BBE.importTx = function( tx ) {
  if (tx.hash || tx.tx_hash)
    tx.hash = Bitcoin.ImpExp.BBE.importHash( tx.hash?tx.hash:tx.tx_hash );
  //else
    // (wallet will calc hash later)
  tx.version = tx.ver;
  tx.timestamp = tx.time;
  // process inputs
  var _ins = [], coinbase=0;
  var insraw = tx['in'] ? tx['in'] : {length:0};
  for( var j=0,ii,scr; j<insraw.length; j++ ) {
    ii = insraw[j];
    ii.outpoint = {hash:Bitcoin.ImpExp.BBE.importHash(ii.prev_out.hash),
                   index:ii.prev_out.n};
    ii.sequence = 4294967295;
    if (ii.coinbase)
      scr = new Bitcoin.Script( Crypto.util.hexToBytes(ii.coinbase) ),
      coinbase++;
    else
      scr = Bitcoin.ImpExp.BBE.importScript( ii.scriptSig );
    ii.script = scr;
    _ins.push( ii );
  }
  tx.ins = _ins;
  if (!tx.hash && !tx.ins.length)
    throw new Error( "Import: no tx inputs and no hash" );
  // process outputs
  var _outs=[];
  for( var j=0,oi; j<tx.out.length; j++ ) {
    oi = tx.out[j];
    if (oi.index || oi.position || oi.tx_output_n) {
      if (oi.tx_output_n) oi.index = oi.tx_output_n;
      oi.position = oi.index ? oi.index+1 : oi.position;
      oi.position--;
      if (oi.position < 0 || oi.position > 10000)
        throw new Error( "Import tx choked on output "+j );
      for( var j2=_outs.length; j2<oi.position; j2++ )
        _outs[j2] = {value:"00000000",
                     script:Bitcoin.ImpExp.BBE.importScript()};
    }
    else
      oi.position = _outs.length;
    if (!oi.value)
      throw new Error( "Import: tx output value unspecified" );
    oi.value = oi.value.toString();
    if (oi.value.indexOf( '.' ) >= 0)
      oi.value = Bitcoin.Util.floatToSatoshis( oi.value );
    if (oi.scriptPubKey != undefined)
      oi.script = Bitcoin.ImpExp.BBE.importScript( oi.scriptPubKey );
    else
      if (oi.script != undefined)
        oi.script = Bitcoin.ImpExp.BCI.importScript( oi.script );
      else {
        oi.address = oi.address ? oi.address : oi.Address;
        if (oi.address)
          oi.script = Bitcoin.Script.createOutputScript( 
                                 new Bitcoin.Address(oi.address) );
        else
          throw new Error( "Import: tx output incomplete" );
      }
    _outs[oi.position] = oi;
  }
  tx.outs = _outs;
  if (!tx.outs.length)
    throw new Error( "Import: no tx outputs" );
  return {'tx':tx,'coinbase':coinbase};
}

Bitcoin.ImpExp.BIO.geterr = function( t ) {
  if (typeof(t) == 'string')
    t = Bitcoin.ImpExp.parseJSON( t );
  if (t.errinternal_)
    return t.errinternal_;
  if (t.status && t.status != 'success')
    return t.data;
  return "";
}

Bitcoin.ImpExp.BBE.importstart = function( txsX, Jthis ) {
  function BIO2BBETime( unixtime ) {
    var d = new Date( unixtime * 1000 );
    return d.toString();
  }
  function BIO2BBEVal( v ) {
    return (new Number(v)).toFixed( 8 );
  }
  function BIO2BBE( BIOTx ) {
    Jthis.err = Bitcoin.ImpExp.BIO.geterr( BIOTx );
    if (Jthis.err)
      return;
    var BBETx = {'in':[], out:[]};
    BBETx.hash = BIOTx.data.tx.txid;
    BBETx.time = BIO2BBETime( BIOTx.data.tx.time );
    for( var i=0; i<BIOTx.data.tx.vin.length; i++ )
      BBETx['in'][i] = { prev_out: {hash: BIOTx.data.tx.vin[i].txid,
                                    n: BIOTx.data.tx.vin[i].vout},
                         scriptSig: BIOTx.data.tx.vin[i].scriptSig.asm};
    for( i=0; i<BIOTx.data.tx.vout.length; i++ )
      BBETx.out[i] = { value: BIO2BBEVal(BIOTx.data.tx.vout[i].value),
                       scriptPubKey: BIOTx.data.tx.vout[i].scriptPubKey.asm };
    Jthis.txs.push( BBETx );
  }
  //  determine if this is single tx or ledger, translate to BBE if needed
  if (txsX.out)  //(single tx)
    Jthis.txs.push( txsX );
  else
    if (txsX.data && txsX.data.tx) //(single tx BIO)
      BIO2BBE( txsX );
    else
      for( var h in txsX ) {
        if (txsX[h].data && txsX[h].data.tx) //(BIO tx)
          BIO2BBE( txsX[h] );
        else
          Jthis.txs.push( txsX[h] );
      }
}

Bitcoin.ImpExp.BCI.importstart = function( txsX, Jthis ) {
  txsX = txsX.unspent_outputs;
  Jthis.txindex = {};
  for( var i=0,tx; i<txsX.length; i++ ) {
    txsX[i].tx_hash = Crypto.util.hexToBytes( txsX[i].tx_hash );
    txsX[i].tx_hash = Crypto.util.bytesToHex( txsX[i].tx_hash.reverse() );
    tx = Jthis.txindex[txsX[i].tx_hash];
    if (!tx) {
      tx = {hash:txsX[i].tx_hash, out:[]};
      Jthis.txs.push( tx );
      Jthis.txindex[tx.hash] = tx;
    }
    tx.out.push( txsX[i] );
  }
  delete Jthis.txindex;
}

Bitcoin.ImpExp.BBE.importer = function( text, wallet, Jthis ) {
  var res = {};
  try {
    if (!Jthis.txs) {
      res.allinvalid = true;
      txsX = JSON.parse( text );
      res.allinvalid = false;
      Jthis.txi = 0, Jthis.txs = [];
      if (txsX.unspent_outputs)
        Bitcoin.ImpExp.BCI.importstart( txsX, Jthis );
      else
        Bitcoin.ImpExp.BBE.importstart( txsX, Jthis );
    }
    while (Jthis.txi < Jthis.txs.length && 
           !Jthis.txs[Jthis.txi].out && !Jthis.txs[Jthis.txi].in)
      Jthis.txi++;  //(skip over dead wood)
    if (Jthis.txi < Jthis.txs.length && !Jthis.err) {
      var i = Jthis.txi; Jthis.txi++;
      res = Bitcoin.ImpExp.BBE.importTx( Jthis.txs[i] );
      Jthis.addTx( res.tx, wallet );
    }
    else
      Jthis.txs = null, res.complete = true;
  }
  catch( e ) {res.tx = null;}
  return res;
}


/*
BlockExplorer export implementation
*/

Bitcoin.ImpExp.BBE.exportHash = function( b64hash ) {
  var hash = Crypto.util.base64ToBytes( b64hash );
  return Crypto.util.bytesToHex( hash.reverse() );
}

Bitcoin.ImpExp.BBE.exportScript = function( script ) {
  var out = [];
  for( var i=0; i<script.chunks.length; i++ ) {
    var chunk = script.chunks[i];
    var op = new Bitcoin.Opcode(chunk);
    typeof chunk == 'number' ?  out.push(op.toString()) :
          out.push(Crypto.util.bytesToHex(chunk));
  }
  return out.join(' ');
}

Bitcoin.ImpExp.BBE.exportTx = function( tx, isSend ) {
  var date = tx.timestamp;
  var hash = tx.hash;
  var r = {};
  if (isSend)
    tx = tx.convertFromSend();  //, r.timestamp = curdate();
  tx = tx.convertToSend();
  if (!hash || hash == tx.hash)
    r['size'] = tx.serialize().length;
  //else
    //r['comment'] = "size not computable, possibly incomplete";
  if (date)
    r['time'] = date;
  r['hash'] = Bitcoin.ImpExp.BBE.exportHash( hash?hash:tx.hash );
  r['ver'] = tx.version;
  r['vin_sz'] = tx.ins.length;
  r['vout_sz'] = tx.outs.length;
  r['lock_time'] = tx.lock_time;
  r['in'] = [];
  r['out'] = [];

  for( var i=0; i<tx.ins.length; i++ ) {
    var txin = tx.ins[i];
    var hash = Bitcoin.ImpExp.BBE.exportHash( txin.outpoint.hash );
    var n = txin.outpoint.index;
    var prev_out = {'hash':hash,'n':n};
    if (n == 4294967295) {
      var cb = Crypto.util.bytesToHex( txin.script.buffer );
      r['in'].push( {'prev_out':prev_out,'coinbase':cb} );
    }
    else {
      var ss = Bitcoin.ImpExp.BBE.exportScript( txin.script );
      r['in'].push( {'prev_out':prev_out,'scriptSig':ss} );
    }
  }

  for( var i=0; i<tx.outs.length; i++ ) {
    var txout = tx.outs[i];
    var value;
    //if (isSend)
      value = Bitcoin.Util.sendTxValueToStr( txout.value );
    //else
    //  value = Bitcoin.Util.formatValue( txout.value.slice(0) );
    var spk = Bitcoin.ImpExp.BBE.exportScript( txout.script );
    var os = {'value':value, 'scriptPubKey':spk};
    var scrinfo = txout.script.getOutAddrs();
    if (scrinfo.descr == 'Address' || scrinfo.descr == 'Pubkey')
      os.Address = scrinfo.addrstrs[0];
    else
      if (scrinfo.descr == 'Multisig') {
        os.M = scrinfo.m;
        for( var j=0; j<scrinfo.addrstrs.length; j++ )
          os['N'+(j+1)] = scrinfo.addrstrs[j];
      }
    os.script = Crypto.util.bytesToHex( txout.script.buffer );
    r['out'].push( os );
  }
  return {hash:r.hash,'JSON':JSON.stringify(r,null,2)};
}

Bitcoin.ImpExp.BBE.exportAddTx = function( tx, text, isSend ) {
  var js = Bitcoin.ImpExp.BBE.exportTx( tx, isSend );
  var tmp = JSON.parse( text );
  tmp[js.hash] = JSON.parse( js['JSON'] );
  return JSON.stringify( tmp, null, 2 );
}

Bitcoin.ImpExp.BBE.exporter = function( tx, Jthis ) {
  var nt = Bitcoin.ImpExp.BBE.exportAddTx( tx, Jthis.text );
  if (nt)
    Jthis.text = nt;
  return nt != null;
}

Bitcoin.ImpExp.BBE.create = function( onProgress, strict ) {
  return new Bitcoin.ImpExp.Processor( Bitcoin.ImpExp.BBE.importer,
                                       Bitcoin.ImpExp.BBE.exporter,
                                       onProgress, strict );
}

Bitcoin.ImpExp.BBE.import = function( text, wallet, onProgress, strict ) {
  var p = Bitcoin.ImpExp.BBE.create( onProgress, strict );
  return p.importAll( text, wallet );
}
Bitcoin.ImpExp.import = Bitcoin.ImpExp.BBE.import;

Bitcoin.ImpExp.BBE.export = function( wallet, onProgress ) {
  var p = Bitcoin.ImpExp.BBE.create( onProgress );
  return p.exportAll( wallet );
}


///////////////////////////////////////////////////////////////
/*
  Loader, connects, downloads transactions, adds them to wallet
    addresses: if provided, addresses to load for, otherwise all 
               addresses in wallet
    txs: list of tx hashes to load
    wallet: if not provided, new wallet is created

    callbacks: onprogress( wallet, txcount ) 
               oncomplete( wallet, txcount )
               onerror( msg )
*/
Bitcoin.ImpExp.Sync = {};

Bitcoin.ImpExp.Sync.URLs = {
  addr: Bitcoin.ImpExp.BIO.addrURL,
  uncaddr: Bitcoin.ImpExp.BIO.uncaddrURL,
  addruseYAPI: false,
  unc: {typ:'JSON',list:'data.unconfirmed',hash:'tx'},
  txsummaries: {typ:'JSON',list:'data.txs',hash:'tx'},
  // BIO address API returns master list with tx summaries
  //    {data: {txs:[ {tx:<hash>} ]} }
  //tx: Bitcoin.ImpExp.BBE.txURL,
  //txuseYAPI: true,
  tx: Bitcoin.ImpExp.BIO.txURL,
  post: Bitcoin.ImpExp.BIO.sendURL,
  postparam: 'hex',
  postokstr: '"status": "success"',
  err: Bitcoin.ImpExp.BIO.geterr
}
Bitcoin.ImpExp.Sync.URLs_testnet = {
  addr: Bitcoin.ImpExp.BIO.addrURL_testnet,
  uncaddr: Bitcoin.ImpExp.BIO.uncaddrURL_testnet,
  addruseYAPI: false,
  txsummaries: {typ:'JSON',list:'data.txs',hash:'tx'},
  unc: {typ:'JSON',list:'data.unconfirmed',hash:'tx'},
  //tx: Bitcoin.ImpExp.BBE.txURL_testnet,
  //txuseYAPI: true,
  tx: Bitcoin.ImpExp.BIO.txURL_testnet,
  post: Bitcoin.ImpExp.BIO.sendURL_testnet,
  postparam: 'hex',
  postokstr: '"status": "success"',
  err: Bitcoin.ImpExp.BIO.geterr
}


/*
  Submit a tx form 
    form.target is an iframe for result dump
*/
Bitcoin.ImpExp.Sync.sendNewTx = function( wallet, callbacks, tx, formel, hexel, _testnet ) {
  function onl( ) {
    try {
      var t = targetIframe.src;
      /*  TODO: extract success or fail
      var t = targetIframe.document.body.innerHTML;
      var i = t.indexOf( base.postokstr );
      if (i < 0)
        return err( "Transaction send failed" );
      */
      if (callbacks.oncomplete)
        callbacks.oncomplete( wallet, 1, t );
    }
    catch( e ) { 
      var m = e.toString();
      err( m );
    }
  }
  function err( e ) {
    console.log( e );
    if (callbacks.onerror)
      callbacks.onerror( e );
  }
  try {
    var base = _testnet ? Bitcoin.ImpExp.Sync.URLs_testnet : Bitcoin.ImpExp.Sync.URLs;
    var targetIframe = document.getElementById( formel.target );
    var txhex = typeof(tx) == 'string' ? tx : Crypto.util.bytesToHex( tx.serialize() );
    //
    hexel.value = txhex;
    hexel.name = base.postparam;
    formel.action = base.post;
    targetIframe.onload = onl;
    //
    var temp = [ targetIframe.src, hexel.name, formel.action, formel.method ];
    formel.submit();
  }
  catch( e ) { 
    var m = e.toString();
    err( m );
  }
}


/*
  Send new tx using JS 
    TODO: test
*/
Bitcoin.ImpExp.Sync.sendNewTx_JS = function( wallet, callbacks, tx, _testnet ) {
  function onp( t ) {
    var err = base.err ? base.err( t ) : "";
    if (err)
      return one( err );
    else
      if (callbacks.oncomplete)
        callbacks.oncomplete( wallet, 1, t );
  }
  function one( e ) {
    if (callbacks.onerror)
      callbacks.onerror( e );
  }
  if (!callbacks._onerror)
    callbacks._onerror = one;
  if (!callbacks.onposted)
    callbacks.onposted = onp;
  var base = _testnet ? Bitcoin.ImpExp.Sync.URLs_testnet : Bitcoin.ImpExp.Sync.URLs;
  var p = {};
  p[base.postparam] = Crypto.util.bytesToHex( tx.serialize() );
  Bitcoin.ImpExp.Sync.postURL( callbacks, base.post, p );
}


/*
*/
Bitcoin.ImpExp.selectDataFromJSON = function( t, select ) {
  var sp = select.split( '.' );
  for( var i=0; t && i<sp.length; i++ )
    t = t[sp[i]];
  return t;
}


/*
*/
Bitcoin.ImpExp.parseJSON = function( t ) {
  if (!t) return {errinternal_:"No data"};
  try {
    t = JSON.parse( t );
  } catch(e) { t = {errinternal_:"Invalid data"}; }
  return t;
}


/*
  load tx data for addresses
    if wallet not provided, new wallet created
    if addresses not provided, addresses in wallet are used
*/
Bitcoin.ImpExp.Sync.loadAddrs = function( wallet, callbacks, addresses, _testnet ) {
  var base = _testnet ? Bitcoin.ImpExp.Sync.URLs_testnet : Bitcoin.ImpExp.Sync.URLs;
  function testfin() {
    uc++;
    if (uc == urls.length) {
      if (callbacks.oncomplete)
        callbacks.oncomplete( wallet, txsin );
      return true;
    }
  }
  function onprog( w, nin ) {
    if (!urls.length) uc=-1,testfin();
    if (callbacks.onprogress)
      callbacks.onprogress( wallet, nin );
  }
  function ontlsummaries( t, i ) {
    var cb = {
      onprogress: function (w,nin) {onprog(w,txsin+nin);},
      oncomplete: function (w,nin) {txsin+=nin;testfin();},
      onerror: function (e) {onte(e);}
    }
    var m = Bitcoin.ImpExp.Sync.extractTxsFromAddrList( t, wallet, base.txsummaries, base.err );
    if (m.err)
      return onte( m.err );
    if (m.length)
      Bitcoin.ImpExp.Sync.loadTxs( wallet, cb, m, _testnet );
    else
      if (!testfin())
        onprog( wallet, txsin );
  }
  function ontl( t ) {
    var status = Bitcoin.ImpExp.import( t, wallet );
    if (status.err)
      return onte( status.err );
    txsin += status.txsAccepted;
    if (!testfin())
      onprog( wallet, txsin );
  }
  function onte( e ) {
    if (callbacks.onerror)
      callbacks.onerror( e );
    return true;
  }
  var b64 = false, txsin = 0, uc = 0;
  if (!wallet)
    wallet = new Bitcoin.Wallet(), wallet.addAddrs( addresses );
  else
    if (!addresses)
      addresses = wallet.addressHashes, b64 = true;
  var urls = Bitcoin.ImpExp.Sync.createAddrURLs( base.addr, addresses, b64, _testnet );
  if (base.txsummaries)
    callbacks.ontextloaded = ontlsummaries;
  else
    callbacks.ontextloaded = ontl;
  callbacks._onerror = onte;
  onprog( wallet, txsin );
  Bitcoin.ImpExp.Sync.loadURLs( callbacks, urls, base.addruseYAPI );
}


/*
  determine if there are unconfirmed txs for addresses
    invokes oncomplete with # unconfs (0 is ok)
*/
Bitcoin.ImpExp.Sync.testUnconfirmed = function( callbacks, addresses, _testnet ) {
  var base = _testnet ? Bitcoin.ImpExp.Sync.URLs_testnet : Bitcoin.ImpExp.Sync.URLs;
  function fin( ) {
    if (callbacks.oncomplete)
      callbacks.oncomplete( null, unconfs );
  }
  function onprog( ) {
    if (callbacks.onprogress)
      callbacks.onprogress( null, unconfs );
  }
  function ontl( t, i ) {
    var m = Bitcoin.ImpExp.Sync.extractTxsFromAddrList( t, null, base.unc, base.err );
    if (m.err)
      return onte( m.err );
    unconfs += m.length;
    onprog( );
  }
  function onte( e ) {
    if (callbacks.onerror)
      callbacks.onerror( e );
    return true;
  }
  var b64 = false, unconfs = 0;
  var urls = Bitcoin.ImpExp.Sync.createAddrURLs( base.uncaddr, addresses, b64, _testnet );
  callbacks.ontextloaded = ontl;
  callbacks._onerror = onte;
  callbacks.onallloaded = fin;
  onprog( null, 0 );
  Bitcoin.ImpExp.Sync.loadURLs( callbacks, urls, base.addruseYAPI );
}


/*
  load txs from txhash array
*/
Bitcoin.ImpExp.Sync.loadTxs = function( wallet, callbacks, txs, _testnet ) {
  var base = _testnet ? Bitcoin.ImpExp.Sync.URLs_testnet : Bitcoin.ImpExp.Sync.URLs;
  function fin() {
    if (callbacks.oncomplete)
      callbacks.oncomplete( wallet, txsin );
  }
  function ontl( t, i ) {
    var status = Bitcoin.ImpExp.import( t, wallet );
    if (status.err)
      return onte( status.err );
    txsin += status.txsAccepted;
    if (callbacks.onprogress)
      callbacks.onprogress( wallet, txsin );
  }
  function onte( e ) {
    if (callbacks.onerror)
      callbacks.onerror( e );
    return true;
  }
  var txsin = 0;
  if (!wallet)
    wallet = new Bitcoin.Wallet();
  callbacks.ontextloaded = ontl;
  callbacks._onerror = onte;
  callbacks.onallloaded = fin;
  var urls = Bitcoin.ImpExp.Sync.createTxURLs( base.tx, txs );
  Bitcoin.ImpExp.Sync.loadURLs( callbacks, urls, base.txuseYAPI );
}


/*
  extract tx hashes from tx summaries array
    if wallet provided, txs already in wallet are excluded
    TODO: distinguish types of tx hashes (b64, b vs l endian, etc)
*/
Bitcoin.ImpExp.Sync.extractTxsFromAddrList = function( t, wallet, descr, errf ) {
  var hl = [];
  if (t) {
    t = Bitcoin.ImpExp.parseJSON( t );
    var e = errf ? errf( t ) : "";
    if (e)
      return {err:e,length:0};
    var txs = Bitcoin.ImpExp.selectDataFromJSON( t, descr.list );
    for( var i=0, h; i<txs.length; i++ ) {
      h = Bitcoin.ImpExp.selectDataFromJSON( txs[i], descr.hash );
      if (!wallet || !wallet.txIndex[Bitcoin.ImpExp.BBE.importHash(h)])
        if (Bitcoin.ImpExp.Sync.isin( hl, h ) < 0)
          hl.push( h );
    }
  }
  return hl;
}


/*
  create url list from addrs
*/
Bitcoin.ImpExp.Sync.createAddrURLs = function( pfx, as, b64, _testnet ) {
  var a, aa, urls = [];
  for( var i=0; i<as.length; i++ ) {
    a = as[i];
    if (!(a instanceof Bitcoin.Address)) {
      if (b64)
        a = Crypto.util.base64ToBytes( a );
      a = new Bitcoin.Address( a );
    }
    a = Bitcoin.ImpExp.Sync.fmtAddr( a, _testnet );
    urls = Bitcoin.ImpExp.Sync.addURLtoList( urls, pfx+a, a );
  }
  return urls;
}


/*
  create url list from txhashes
*/
Bitcoin.ImpExp.Sync.createTxURLs = function( pfx, txs, b64 ) {
  var urls = [];
  for( var i=0, tx; i<txs.length; i++ ) {
    tx = txs[i];
    if (b64)
      tx = Bitcoin.ImpExp.BBE.exportHash( tx );
    urls = Bitcoin.ImpExp.Sync.addURLtoList( urls, pfx+tx, tx );
  }
  return urls;
}


/*
  add url to list if not already
*/
Bitcoin.ImpExp.Sync.addURLtoList = function( urls, u, dat ) {
  var d = {url:u,data:dat};
  for( var i=0; i<urls.length; i++ )
    if (urls[i].url == u)
      return urls;
  urls.push( d );
  return urls;
}


/*
  find in arr
*/
Bitcoin.ImpExp.Sync.isin = function( arr, item ) {
  for( var i=0; i<arr.length; i++ )
    if (arr[i] == item)
      return i;
  return -1;
}


/*
  load several URLs, one at a time
*/
Bitcoin.ImpExp.Sync.loadURLs = function( callbacks, urls, useYAPI ) {
  function ontl( t ) {
    if (ontl_ && t)
      stopit = ontl_( t, next );
    if (stopit)
      return;
    next++;
    if (next < urls.length)
      Bitcoin.ImpExp.Sync.loadURL( callbacks, urls[next].url, useYAPI );
    else
      if (callbacks.onallloaded)
        callbacks.onallloaded();
  }
  var next = -1, stopit = false;
  var ontl_ = callbacks.ontextloaded;
  callbacks.ontextloaded = ontl;
  ontl();
}


/*
  load a url, get text
*/
Bitcoin.ImpExp.Sync.loadURL = function( callbacks, url, useYAPI ) {
  if (useYAPI)
    return Bitcoin.ImpExp.Sync.loadURL_YAPI( callbacks, url );
  function uniqueURL( url ) {
    var cd = new Date();
    var u = url.split( '?' );
    url += u.length > 1 ? '&' : '?';
    url += cd.getTime().toString();
    return url;
  }
  function transferComplete( t, s ) {
    /*if (!t || t.substr(0,3) == 'ERR')
      if (callbacks._onerror)
        return callbacks._onerror( "Invalid response" );*/
    if (callbacks.ontextloaded)
      callbacks.ontextloaded( t );
  }
  url = uniqueURL( url );
  //url = encodeURIComponent(url);
  callbacks._oncomplete = transferComplete;
  Bitcoin.ImpExp.Sync.doURL( callbacks, url, "GET" );
}


/*
  load a url, get text (uses YAPI to bypass CORS restrictions)
*/
Bitcoin.ImpExp.Sync.loadURL_YAPI = function( callbacks, url ) {
  function uniqueURL( url ) {
    var cd = new Date();
    var u = url.split( '?' );
    url += u.length > 1 ? '&' : '?';
    url += cd.getTime().toString();
    return url;
  }
  function transferComplete( t, s ) {
    // extract result from yapi
    var i1 = t.indexOf( "<p>" );
    var i2 = t.indexOf( "</p>" );
    if (i1 < 0 || i2 < 0)
      if (callbacks._onerror)
        return callbacks._onerror( "Invalid response" );
    i1 += 3;
    var t = t.substr( i1, i2-i1 );
    if (callbacks.ontextloaded)
      callbacks.ontextloaded( t );
  }
  // kludge to bypass cross domain restriction in JS
  url = uniqueURL( url );
  url = 'select * from html where url="' + url + '"';
  url = 'https://query.yahooapis.com/v1/public/yql?q=' + encodeURIComponent(url);
  callbacks._oncomplete = transferComplete;
  Bitcoin.ImpExp.Sync.doURL( callbacks, url, "GET" );
}


/*
  post a url, get reply
*/
Bitcoin.ImpExp.Sync.postURL = function( callbacks, url, params ) {
  function transferComplete( t ) {
    console.log( t );
    if (callbacks.onposted)
      callbacks.onposted( t );
  }
  callbacks._oncomplete = transferComplete;
  var p = "";
  for( name in params )
    p += name + '=' + params[name];
  Bitcoin.ImpExp.Sync.doURL( callbacks, url, "POST", p, 
                             {'Content-type':'application/x-www-form-urlencoded',
                              'Content-length': p.length } );
}


/*
  post a url, get reply
*/
Bitcoin.ImpExp.Sync.postURL_notused = function( callbacks, url, data ) {
  function transferComplete( t ) {
    console.log( t );
    if (callbacks.onposted)
      callbacks.onposted( t );
  }
  callbacks._oncomplete = transferComplete;
  var FD  = new FormData();
  for( name in data )
    FD.append( name, data[name] );
  Bitcoin.ImpExp.Sync.doURL( callbacks, url, "POST", FD );
}


/*
  get or post a url
*/
Bitcoin.ImpExp.Sync.activeReqs = {};
Bitcoin.ImpExp.Sync.activeReqsProcessId = 0;
Bitcoin.ImpExp.Sync.doURL = function( callbacks, url, meth, params, hdrs ) {
  function onProgress( e ) {
    if (e.lengthComputable)
      if (callbacks._onprogress)
        callbacks._onprogress( (e.loaded*100)/e.total );
  }
  function transferComplete( e ) {
    delete Bitcoin.ImpExp.Sync.activeReqs[processId];
    var s = this.status;
    var t = this.responseText;
    if (!t)
      err( "No response" );
    else
      if (callbacks._oncomplete)
        callbacks._oncomplete( t, s, e );
  }
  function err( m ) {
    delete Bitcoin.ImpExp.Sync.activeReqs[processId];
    if (callbacks._onerror)
      callbacks._onerror( m );
  }
  function transferFailed( ) {
    var m = this.status==404 ? "URL not found" :
                               "No connection or server unresponsive";
    err( m );
  }
  function transferCanceled( e ) {
    var s = this.status;
    err( "Operation canceled" );
  }
  Bitcoin.ImpExp.Sync.activeReqsProcessId++;
  var processId = 'pid' + Bitcoin.ImpExp.Sync.activeReqsProcessId;
  try {
    var req = new XMLHttpRequest();
    req.addEventListener( "progress", onProgress, false );
    req.addEventListener( "load", transferComplete, false );
    req.addEventListener( "error", transferFailed, false );
    req.addEventListener( "abort", transferCanceled, false );
    req.open( meth, url, true );
    if (callbacks._onprogress)
      callbacks._onprogress( 0 );
    if (hdrs) //TODO: brkpt
      for( var i in hdrs )
        req.setRequestHeader( i, hdrs[i] );
    if (params)
      req.send( params );
    else
      req.send();
    Bitcoin.ImpExp.Sync.activeReqs[processId] = req;
    //setTimeout( function(){Bitcoin.ImpExp.Sync.abort(processId)}, 1000*60 );
    return processId;
  }
  catch( e ) { 
    var m = e.toString();
    err( m );
  }
}
Bitcoin.ImpExp.Sync.abort = function( processId ) {
  if (processId) {
    if (Bitcoin.ImpExp.Sync.activeReqs[processId])
      Bitcoin.ImpExp.Sync.activeReqs[processId].abort();
  }
  else {
    for( var processId in Bitcoin.ImpExp.Sync.activeReqs )
      Bitcoin.ImpExp.Sync.activeReqs[processId].abort();
    Bitcoin.ImpExp.Sync.activeReqs = {};
  }
}


/*
  get address str in testnet fmt as needed
*/
Bitcoin.ImpExp.Sync.fmtAddr = function( a, _testnet ) {
  if (_testnet) {
    a = new Bitcoin.Address( a.toString() );
    a.version = 0x6F;
  }
  return a.toString();
}



///////////////////////////////////////////////////////////////
/* 
  some BCI and BBE test data 
  keys:
    wind glue oat golf ear mug seat wave wire
    5J396V1kf8Z7ffWKQZpJYzWSNzKFhcuK5PLKP9ZdNLunzPL8NYS
*/

Bitcoin.ImpExp.BCI.sampleTx = JSON.stringify( {
  "comment": "some pretend transaction data in BCI format; "+
             "manually entered data needs precise "+
             "formatting (ie, missing "+
             "or misplaced quote/comma/etc " +
             "invalidates entire text)",
  "unspent_outputs" : [
    {
      "tx_hash": "acbeaeecdfacadceaaaecbecdfaffabcadeeabddfcfaaadcedaaeeafabcdbdf0",
      "tx_output_n": 3,
      "value": "2.00",
      "address":"16hKnJhyhi7dn76s7eHoWmWhmmxnB2kVpz"
    },
    { 
      "tx_hash":
"acbeaeecdfacadceaaaecbecdfaffabcadeeabddfcfaaadcedaaeeafabcdbdf0", 
      "tx_output_n": 5,
      "value": "1000000000", 
      "script": "76a914b92bc4ea6ee731278e7078fbaf611ec781db751988ac"
    },
    {
      "tx_hash":
"892ff4273078bdae7230ace725872a1c6d2da6e1efa6c8d950a1aa24e0f5b874", 
      "tx_output_n": 0,
      "value": "65000000",
      "script": "524104eb7f3030eabf8ddcd93cfc190e81bb26707f387c0dc5d2e678501470b2d827e4b2b97dea7043524d505812a0e2d928c34fb172b6c24eb573ee4ea0366f2cd5b84104f49a2b697137978bb31d8059d94dce7e713c2e023805d18eb01f7e2f469747642e90ff2a3817ed9165392d7ebe879ea5e508ffd19d9dee98956ca5f35a587fa541043dd2bcfe0e4475774278de9124fbb49378116e737be0c95fbfeddc977d48c47041924e4113ef217f8e29aa13b5e255ce37705bad7d2f25a438e24cd0c8145cb553ae"
    }
  ]
} );

Bitcoin.ImpExp.BIO.sampleTx = JSON.stringify(
{
"1": {
  "time": 1403745245,
  "data": {
    "tx": {
      "txid": "acbeaeecdfacadceaaaecbecdfaffabcadeeabddfcfaaadcedaaeeafabcdbdf0",
      "vin": [
        {
          "txid": "12b34ee5d67890c22a237b79d5af31b100e2abdd8c670ad4eda1ee22a040bd37",
          "vout": 0,
          "scriptSig": {
            "asm": "3046022100beeaaf1cbff7162efc1a7fa8b69dd43dfdaff2b4cf707cf2c39f74dd65a604850221009a858997ddfd262470afe4a2a1b3f3dd25eeb0fcb23b622f7908c179eebc039001 04e791c0bb249d2a5197683b17569a402a5be87d0bf01977db6056773557e5cd211e3677b10e11dfb0068da5ff41c2f1c6e162ebcaf43973b4bacec6b06fdcbd71"
          },
          "sequence": 4294967295
        }
      ],
      "vout": [
        {
          "value": 1,
          "scriptPubKey": {
            "asm": "OP_DUP OP_HASH160 3e78f1f1103731f8dfdb339bb26a6c8f4208f4f2 OP_EQUALVERIFY OP_CHECKSIG"
          }
        }
      ]
    }
  }
} 
} );

Bitcoin.ImpExp.BBE.sampleTx = JSON.stringify( {
  "comment": "some pretend transaction data; "+
  "manually entered data needs precise "+
  "formatting (ie, missing "+
  "or misplaced quote/comma/etc " +
  "invalidates entire text)",
  "Transaction 1 (partial)": {
    "hash": "acbeaeecdfacadceaaaecbecdfaffabcadeeabddfcfaaadcedaaeeafabcdbdf0",
    "time": "2013-08-03 11:53:17",
    "out": [
      {
        "comment": "selected output from transaction (6th)",
        "index": 5,
        "value": "10.0",
        "Address": "1Ht6SdKEN3PFxXxbbbb4zpCXZuYJJ768yT"
      }
    ]
  },
  "Transaction 2 (complete, will hash)": {
    "time": "2013-08-27 16:53:32",
    "in": [
      {
        "prev_out": {
          "hash": "12b34ee5d67890c22a237b79d5af31b100e2abdd8c670ad4eda1ee22a040bd37",
          "n": 5
        },
        "scriptSig": "3046022100beeaaf1cbff7162efc1a7fa8b69dd43dfdaff2b4cf707cf2c39f74dd65a604850221009a858997ddfd262470afe4a2a1b3f3dd25eeb0fcb23b622f7908c179eebc039001 04e791c0bb249d2a5197683b17569a402a5be87d0bf01977db6056773557e5cd211e3677b10e11dfb0068da5ff41c2f1c6e162ebcaf43973b4bacec6b06fdcbd71"
      },
      {
        "prev_out": {
          "hash": "3ea954b49d0962c80d95187813bae63f63bfcbf45f11c98e638dcbac198d3564",
          "n": 2
        },
        "scriptSig": "3045022100e94ffcaea942d7a462ab6dc2c3023e8905e67f64075824ea6fd68afbeb774352022072b30ab5b29d90bbf45fa72c32699eb255069ca0a8f3ab46f518525a10793ee501 04e791c0bb249d2a5197683b17569a402a5be87d0bf01977db6056773557e5cd211e3677b10e11dfb0068da5ff41c2f1c6e162ebcaf43973b4bacec6b06fdcbd71"
      },
      {
        "prev_out": {
          "hash": "8ff067f9235bd5827ebc8361c847e8e5a55b839fac34916f0e8b5690be957de5",
          "n": 2
        },
        "scriptSig": "3046022100f62765713f8e77ce5e0ca467f86287e50963290b25532b5ba0a2d487b4767d2b022100be5ebab82426076667c9f1b9382616224f31d46697bdca53279c6ddc209e8cde01 04e791c0bb249d2a5197683b17569a402a5be87d0bf01977db6056773557e5cd211e3677b10e11dfb0068da5ff41c2f1c6e162ebcaf43973b4bacec6b06fdcbd71"
      }
    ],
    "out": [
      {
        "value": "77.70",
        "scriptPubKey": "OP_2 04eb7f3030eabf8ddcd93cfc190e81bb26707f387c0dc5d2e678501470b2d827e4b2b97dea7043524d505812a0e2d928c34fb172b6c24eb573ee4ea0366f2cd5b8 043dd2bcfe0e4475774278de9124fbb49378116e737be0c95fbfeddc977d48c47041924e4113ef217f8e29aa13b5e255ce37705bad7d2f25a438e24cd0c8145cb5 OP_2 OP_CHECKMULTISIG",
        "M": 2,
        "N1": "1Ht6SdKEN3PFxXxbbbb4zpCXZuYJJ768yT",
        "N2": "16hKnJhyhi7dn76s7eHoWmWhmmxnB2kVpz"
      },
      {
        "value": "12.3456789",
        "scriptPubKey": "OP_DUP OP_HASH160 3e78f1f1103731f8dfdb339bb26a6c8f4208f4f2 OP_EQUALVERIFY OP_CHECKSIG",
        "Address": "16hKnJhyhi7dn76s7eHoWmWhmmxnB2kVpz"
      },
      {
        "value": "9.09876",
        "scriptPubKey": "OP_DUP OP_HASH160 b92bc4ea6ee731278e7078fbaf611ec781db7519 OP_EQUALVERIFY OP_CHECKSIG",
        "Address": "1Ht6SdKEN3PFxXxbbbb4zpCXZuYJJ768yT"
      },
      {
        "value": "3.00",
        "scriptPubKey": "OP_TRUE 043dd2bcfe0e4475774278de9124fbb49378116e737be0c95fbfeddc977d48c47041924e4113ef217f8e29aa13b5e255ce37705bad7d2f25a438e24cd0c8145cb5 04eb7f3030eabf8ddcd93cfc190e81bb26707f387c0dc5d2e678501470b2d827e4b2b97dea7043524d505812a0e2d928c34fb172b6c24eb573ee4ea0366f2cd5b8 OP_2 OP_CHECKMULTISIG",
        "M": 1,
        "N1": "16hKnJhyhi7dn76s7eHoWmWhmmxnB2kVpz",
        "N2": "1Ht6SdKEN3PFxXxbbbb4zpCXZuYJJ768yT"
      },
      {
        "value": "0.66006109",
        "scriptPubKey": "OP_DUP OP_HASH160 b442b2019a72c0bd98e2a10fff4fe1ac22ed7f20 OP_EQUALVERIFY OP_CHECKSIG"
        //"Address": "1HS8XbxaamR23pRBkoB4Hdb3Z5DgPsBztt"
      }
    ]
  },
  "Transaction 3": {
    "time": "2013-08-28 03:43:02",
    //"ver": 1,
    //"vin_sz": 1,
    //"vout_sz": 2,
    //"lock_time": 0,
    "in": [
      {
        "prev_out": {
          "hash": "225febc7b4572a102ee03bf9a62023319aa0dcd3f74d8ee08df0ce0525d5179e",
          "n": 4
        },
        "scriptSig": "304502210086304db3ae8bfe8547dec22998c1e092997f5a317fbd48439eb2d6e66588aef0022044175075a6c86ca085ef68a07a67833c52221c59f8479f3ec5399c7ef828622b01 04e791c0bb249d2a5197683b17569a402a5be87d0bf01977db6056773557e5cd211e3677b10e11dfb0068da5ff41c2f1c6e162ebcaf43973b4bacec6b06fdcbd71"
      }
    ],
    "out": [
      {
        "value": "0.65",
        "scriptPubKey": "OP_2 04eb7f3030eabf8ddcd93cfc190e81bb26707f387c0dc5d2e678501470b2d827e4b2b97dea7043524d505812a0e2d928c34fb172b6c24eb573ee4ea0366f2cd5b8 04f49a2b697137978bb31d8059d94dce7e713c2e023805d18eb01f7e2f469747642e90ff2a3817ed9165392d7ebe879ea5e508ffd19d9dee98956ca5f35a587fa5 043dd2bcfe0e4475774278de9124fbb49378116e737be0c95fbfeddc977d48c47041924e4113ef217f8e29aa13b5e255ce37705bad7d2f25a438e24cd0c8145cb5 OP_3 OP_CHECKMULTISIG",
        "M": 2,
        "N1": "1Ht6SdKEN3PFxXxbbbb4zpCXZuYJJ768yT",
        "N2": "14Dbmkg9mgXxQNoPLpWmG3xaz4nWR6hqEM",
        "N3": "16hKnJhyhi7dn76s7eHoWmWhmmxnB2kVpz"
      },
      {
        "value": "0.00956109",
        "scriptPubKey": "OP_DUP OP_HASH160 b442b2019a72c0bd98e2a10fff4fe1ac22ed7f20 OP_EQUALVERIFY OP_CHECKSIG"
        //"Address": "1HS8XbxaamR23pRBkoB4Hdb3Z5DgPsBztt"
      }
    ]
  }
} );



/*

BIOSingleTx =
{
  "time": <unix time>,
  "status": "success",
  "data": {
    "tx": {
      "txid": <hash>,
      "vin": [
        {
          "txid": <hash>,
          "vout": 1,
          "scriptSig": {
            "asm": <BBE script>
          },
          "sequence": 4294967295
        }
      ],
      "vout": [
        {
          "value": 1.0e-8,
          "scriptPubKey": {
            "asm": <BBE script>,
          }
        }
      ]
    }
  }


BIOTxList =
{
"1": {
  "time": 1403745245,
  "data": {
    "tx": {
      "txid": <hash>,
      "vin": [
        {
          "txid": <hash>,
          "vout": 1,
          "scriptSig": {
            "asm": <BBE script>
          },
          "sequence": 4294967295
        }
      ],
      "vout": [
        {
          "value": 1.0e-8,
          "scriptPubKey": {
            "asm": <BBE script>,
          }
        }
      ]
    }
  },
"2": {
  "time": <unix time>,
  "status": "success",
  "data": {
    "tx": {
      "txid": <hash>,
      "vin": [
        {
          "txid": <hash>,
          "vout": 1,
          "scriptSig": {
            "asm": <BBE script>
          },
          "sequence": 4294967295
        }
      ],
      "vout": [
        {
          "value": 1.0e-8,
          "scriptPubKey": {
            "asm": <BBE script>,
          }
        }
      ]
    }
  }
}



  "BBETX": {
    "time": "2013-08-28 03:43:02",
    "in": [
      {
        "prev_out": {
          "hash": <tx hash>,
          "n": 4
        },
        "scriptSig": <BBE script>
       }
    ],
    "out": [
      {
        "value": "0.00956109",
        "scriptPubKey": <BBE script>
      }
    ]
  }




BIOAddrList
{
	"status": "success",
	"data": {
		"address": <addr>,
		"limit_txs": 200,
		"nb_txs": 2,
		"nb_txs_displayed": 2,
		"txs": [
			{
				"tx": <txhash>
				"time_utc": "2014-06-27T01:19:15Z",
				"confirmations": 160,
				"amount": -1.0e-5,
				"amount_multisig": -1.0e-8
			},
			{
				"tx": <txhash>
				"time_utc": "2014-01-02T13:44:29Z",
				"confirmations": 3,
				"amount": -1.0e-5,
				"amount_multisig": -1.0e-8
			}
		]
	},
	"code": 200,
	"message": ""
}


*/

