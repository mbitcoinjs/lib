/*
  extensions to bitcoinjs-lib (inherits license of bitcoinjs-lib)
    Wallets: some additions and a few overrides to add support for
      multi-signature and data outputs, etc., see below
    Addresses and keys: extensions to support brainwallet passphrases,
      also vanity address miner, see Bitcoin.Address.mine()
*/


/*
  Bitcoin.Wallet extensions
  -------------------------
 
  Multisig: recognizes multisig as spendable if the required M addresses
    are in the wallet, signs/spends with M keys 

  Data outputs: recognizes and writes data outputs 
    writes: OP_RETURN <up to 40 bytes>

  Bitcoin.Wallet.createSend2(): new version of createSend with multisig
    and data output support, also supports multiple outputs and async mode

  Bitcoin.Wallet.selectOutputs(): determine which spendables will be redeemed
    for a pending transaction and calc helpful stats about it

  Bitcoin.Wallet.queryOutputs(): searches an output dataset, examples:
    w.queryOutputs( 'unspentOuts', {descr:'Multisig',eqM:2,eqN:3} );
      finds M=2,N=3 multisig outputs spendable by keys in wallet
    w.queryOutputs( 'prunedOuts', {addr:'16hKnJhyhi7dn76s7eHoWmWhmmxnB2kVpz'} );
      finds known spent outputs containing addr (including multisigs)
    w.queryOutputs( 'allOuts', {descr:'Data',eqdata:'ff0011'} );
      finds data outputs that start with the three bytes 'ff0011'

  Bitcoin.Wallet.queryInputs(): searches inputs

  Wallets w/o keys: useful for search wallets and to allow users to work
    with wallets without divulging private keys
*/


/*
  add tx (tx or data) to wallet
    optional params:
      isSend: <bool> if a send tx is being added back to wallet, 
        its outputs are deemed unconfirmed and will not be spent
      suppressHashVerify: <bool>, by default, tx is rehashed, if tx.hash 
        defined and not same, fail
      pruneDelay: <bool> for faster tx intake, set pruneDelay=true and 
        call .pruneSpentOutputs() after all txs added, see .reprocess();
    returns tx hash
*/
Bitcoin.Wallet.prototype.addTx = function( 
                              tx, isSend, suppressHashVerify, pruneDelay ) {
  var newtx = Bitcoin.Transaction.prepForWallet( 
                                          tx, isSend, suppressHashVerify );
  this.process2( newtx, isSend, pruneDelay );
  return newtx.hash;
}


/*
  delete tx from wallet, optional: only del if unconfirmed
*/
Bitcoin.Wallet.prototype.delTx = function( txhash, unconfirmed ) {
  var tx = txhash ? this.txIndex[txhash] : null;
  if (tx && !tx.unconfirmed && unconfirmed)
    tx = null;
  if (tx) {
    var i2 = {};
    for( var h in this.txIndex )
      if (h != txhash)
        i2[h] = this.txIndex[h];
    this.txIndex = i2;
    this.reprocess();
  }
}


/*
  confirm tx in wallet (outputs can become spendable)
*/
Bitcoin.Wallet.prototype.confirmTx = function( txhash ) {
  var tx = txhash ? this.txIndex[txhash] : null;
  if (tx && tx.unconfirmed) {
    tx.unconfirmed = false;
    this.reprocess();
  }
}


/*
  new version of wallet.process to recognize spendable multisig outs;
    for faster tx intake, set pruneDelay=true and call 
      wallet.pruneSpentOutputs() after all txs added, see .reprocess()
*/
Bitcoin.Wallet.prototype.process2 = function( tx, unconfirmed, pruneDelay ) {
  unconfirmed = unconfirmed ? true : false;
  if (this.txIndex[tx.hash]) {
    tx = this.txIndex[tx.hash];
    tx.unconfirmed = unconfirmed;
    return;
  }
  tx.unconfirmed = unconfirmed;
  if (!this.unspentOuts) this.unspentOuts = [];
  if (!this.exitOuts) this.exitOuts = [];
  if (!this.allOuts) this.allOuts = [];
  if (!this.inputRefIndex) this.inputRefIndex = {};
  //  gather outputs
  for( var j=0; j<tx.outs.length; j++ ) {
    var txout = new Bitcoin.TransactionOut( tx.outs[j] );
    v = Bitcoin.Util.valueToBigInt( txout.value );
    if (v.compareTo(BigInteger.ZERO) > 0) {
      this.allOuts.push( {'tx':tx, index:j, out:txout} );
      if (this.isOutputScriptSpendable( txout.script ))
        this.unspentOuts.push( {'tx':tx, index:j, out:txout} );
      else
        this.exitOuts.push( {'tx':tx, index:j, out:txout} );
    }
  }
  //  add input pointers to inpRefIndex
  for( var j=0,inp; j<tx.ins.length; j++ ) {
    inp = tx.ins[j].outpoint;
    if (this.inputRefIndex[inp.hash+':'+inp.index])
      throw new Error( "Wallet contains double spends, resync needed" );
    this.inputRefIndex[inp.hash+':'+inp.index] = {'tx':tx, index:j, in:tx.ins[j]};
  }
  //  index transaction
  this.txIndex[tx.hash] = tx;
  this.txCount = this.txCount ? this.txCount+1 : 1;
  //  prune spent outputs
  if (!pruneDelay)
    this.pruneSpentOutputs();
}


/*
  new version of createSend, w support for multi-outputs and multisig;
    sendTos, chgTo, excludes: see wallet.selectOutputs
    keys(optional): array of ECKey needed to sign tx (wallet keys ignored)
    callback(optional): if provided, invokes async mode
      cancel = callback( "complete"|"fail"|"progress", 
                         wallet, sendTx, step, numSteps )
    returns: new tx or null if fail, n/a if async mode
*/
Bitcoin.Wallet.prototype.createSend2 = function( 
                            sendTos, chgTo, fee, keys, excludes, callback ) { 
  var s = this.createSendTxUnsigned( sendTos, chgTo, fee, excludes );
  if (callback)
    return this.signSendTxAsync( s.tx, s.selectedOuts, keys, callback );
  return this.signSendTx( s.tx, s.selectedOuts, keys );
}


/*
  determine what outputs to select for a pending send tx,
       (see transaction.addOutput2 for param details)
    if no params passed, will return stats for all spendable outs
    excludes(optional): array of <bool>, if excludes[i], out not considered
  returns (values are BigInteger)
    { total:<sum of all spendable output values>,
      avail:<total - excluded - unconfirmed>,
      unconfirmed:<sum of unconfirmed>,
      excluded:<sum of excluded>,
      value:<tx total>, (clipped to avail if insufficient funds)
      out:<sum of outputs selected>,
      change:<>, 
      fee:<>,
      selectedOuts:[], 
      outsStats:[], 
      insufficientFunds:<bool> }
  if getStats==true, outsStats is loaded with array of:
    { willSpend:<bool>,
      value,
      txHash,
      index,
      descr:"Address"|"Multisig"|"Pubkey",
      N,M,addrs[],
      unconfirmed,
      tx:<transaction in cache> }
*/
Bitcoin.Wallet.prototype.selectOutputs = function( 
                                 sendTos, chgTo, fee, getStats, excludes ) {
  var ret = {selectedOuts:[],outsStats:[]};
  var vals = [];
  if (!sendTos) sendTos = [];
  if (!chgTo) chgTo = {};
  if (!fee) fee = BigInteger.ZERO;
  if (getStats == undefined) getStats = true;
  if (!excludes) excludes = [];

  //  determine how much is being spent
  ret.value = BigInteger.ZERO;
  for( var i=0; i<sendTos.length; i++ ) {
    vals[i] = Bitcoin.Util.parseValue2( sendTos[i].value );
    ret.value = ret.value.add( vals[i] );
  }
  ret.fee = Bitcoin.Util.parseValue2( fee );
  ret.amount = ret.value.add( BigInteger.ZERO );
  ret.value = ret.value.add( ret.fee );

  //  process outputs 
  ret.avail = ret.out = ret.unconfirmed = 
              ret.total = ret.excluded = BigInteger.ZERO;
  var sp, biv, uo;
  for ( i=0; i<this.unspentOuts.length; i++ ) {
    uo = this.unspentOuts[i];
    biv = Bitcoin.Util.valueToBigInt( uo.out.value );
    sp = (ret.avail.compareTo(ret.value) < 0)  && 
         !excludes[i] && 
         !uo.tx.unconfirmed;
    if (sp) {
      ret.out = ret.out.add( biv );
      ret.selectedOuts.push( uo );
    }
    if (getStats) {
      var s = uo.out.script.getOutAddrs();
      ret.outsStats.push( {willSpend:sp,
                           value:biv, 
                           txHash:uo.tx.hash,
                           index:uo.index,
                           descr:s.descr,
                           N:s.addrs.length,
                           M:s.m,
                           addrs:s.addrs,
                           'unconfirmed':uo.tx.unconfirmed,
                           tx:uo.tx} );
    }
    if (!excludes[i] && !uo.tx.unconfirmed)
      ret.avail = ret.avail.add( biv );
    if (uo.tx.unconfirmed)
      ret.unconfirmed = ret.unconfirmed.add( biv );
    if (excludes[i])
      ret.excluded = ret.excluded.add( biv );
    ret.total = ret.total.add( biv );
  }
  if (ret.avail.compareTo(ret.value) < 0) {
    ret.insufficientFunds = true;
    chgTo.value = ret.change = BigInteger.ZERO;
    ret.value = ret.avail.add( BigInteger.ZERO );
    ret.amount = ret.value.subtract( ret.fee );
    if (ret.amount.compareTo(BigInteger.ZERO) < 0)
      ret.fee = BigInteger.ZERO,
      ret.amount = ret.value = ret.avail;
  }
  else
    chgTo.value = ret.change = ret.out.subtract( ret.value );
  return ret;
}


/*
  add addrs to address wallet (keys are cleared)
*/
Bitcoin.Wallet.prototype.addAddrs = function( addrs, reset ) {
  this.clear();
  if (reset || !this.isAddressWallet)
    this.addressHashes=[];
  for( var i=0, a; i<addrs.length; i++ ) {
    a = addrs[i];
    if (typeof(a) == 'string')
      a = new Bitcoin.Address( a );
    var h64 = a.getHashBase64();
    if (!this.hasHash( h64 ))
      this.addressHashes.push( h64 );
  }
  this.isAddressWallet = true;
  this.reprocess();
}


/*
  add keys to address wallet before signing new tx
*/
Bitcoin.Wallet.prototype.resetToKeyWallet = function( keys ) {
  /*this.isAddressWallet = false;
  this.clear();
  this.savedAddressHashes = this.addressHashes;
  this.addressHashes = [];
  for( var i=0; i<keys.length; i++ )
    this.addKey( keys[i] );
  */
  this.savedAddressHashes = this.replaceKeys( keys );
}


/*
  replace or clear keys in wallet
    keys (optional): if provided, array of new keys
    reprocess (optional): .reprocess() is called following key replacement 
*/
Bitcoin.Wallet.prototype.replaceKeys = function( keys, reprocess ) {
  this.isAddressWallet = false;
  this.clear();
  var ah = this.addressHashes;
  this.addressHashes = [];
  if (keys)
    for( var i=0; i<keys.length; i++ )
      this.addKey( keys[i] );
  if (reprocess)
    this.reprocess();
  return ah;
}


/*
  clear keys in address wallet after signing new tx
*/
Bitcoin.Wallet.prototype.resetAddrWallet = function( ) {
  if (!this.savedAddressHashes)
    return;
  this.isAddressWallet = true;
  this.clear();
  this.addressHashes = this.savedAddressHashes;
  this.savedAddressHashes = null;
}


/*
  select outs matching all filters, ie, 
        'select * from FROM where filter1 [ AND filter2 [AND ...] ] ]'
    FROM= 'allOuts' | 'exitOuts' | 'unspentOuts' | 'prunedOuts'
      prunedOuts: outs payed to another tx in wallet (known spent)
      exitOuts: outs not spendable and not pruned
      unspentOuts: outs spendable by addrs in wallet
    filter: {
      one or more of:
        txHash: <b64>
        mindate: <min date>
        maxdate: <max date>
        index: <int>
        minvalue: <minv>
        maxvalue: <maxv>
        eqvalue: <=to>
        descr: 'Multisig' | 'Address' | 'Pubkey' | 'Data'
        addr: <std addr str> (matches any in out)
        addr<i>: <std addr str> (matches only out.addr[i])
        minM: <min>
        minN: <min>
        maxM: <max>
        maxN: <max>
        eqM: <=to>
        eqN: <=to>
        eqdata: <=hex str> (matches partial, eg, eqdata "a4" finds "a4c" "a40",
          if dataoffset defined, match tests substr at dataoffset 
    }
    input values can be strings or BigInteger
  returns 
    { outsStats:[ 
         {value,txHash,descr,N,M,addrs[],unconfirmed,tx,index,data }, ... ],
      unconfirmed:<total val of matches marked unconfirmed> }
    returned values are BigInteger
    outStats[i].tx is ptr to cached transaction, index is output index in tx
  TODO: add support for regexp matches
*/
Bitcoin.Wallet.prototype.queryOutputs = function( from, filters ) {
  var fr;
  var ret = {unconfirmed:BigInteger.ZERO,outsStats:[]};
  function cmpv( v, vc ) {
    v = Bitcoin.Util.valueToBigInt( v );
    vc = Bitcoin.Util.parseValue2( vc );
    return v.compareTo( vc );
  }
  function cmpn( n, nc ) {
    return (n<nc) ? -1 : ((n>nc) ? 1 : 0);
  }
  function match1( o, fn, fv, filters ) {
    if (fn == 'txHash')
      return fv == o.tx.hash;
    if (fn == 'mindate')
      return o.tx.timestamp >= fv;
    if (fn == 'maxdate')
      return o.tx.timestamp <= fv;
    if (fn == 'index')
      return fv == o.index;
    if (fn == 'eqvalue')
      return cmpv(o.out.value,fv) == 0;
    if (fn == 'minvalue')
      return cmpv(o.out.value,fv) >= 0;
    if (fn == 'maxvalue')
      return cmpv(o.out.value,fv) <= 0;
    //
    var as = o.out.script.getOutAddrs();
    if (fn == 'descr')
      return as.descr == fv;
    if (fn == 'addr')
      for( var j=0; j<as.addrs.length; j++ )
        if (as.addrs[j].toString() == fv.toString())
          return true;
    if (fn.substr(0,4) == 'addr' && as.addrs.length) {
      var i = fn.substr( 4, fn.length-4 );
      if (as.addrs[i].toString() == fv.toString())
        return true;
    }
    if (fn == 'eqmemo' && as.dataText) {
      var ofs = filters.memooffset ? filters.memooffset : 0;
      return as.dataText.substr( ofs, fv.length ) == fv;
    }
    if (fn == 'eqM')
      return cmpn(as.m,fv) == 0;
    if (fn == 'minM')
      return cmpn(as.m,fv) >= 0;
    if (fn == 'maxM')
      return cmpn(as.m,fv) <= 0;
    if (fn == 'eqN')
      return cmpn(as.addrs.length,fv) == 0;
    if (fn == 'minN')
      return cmpn(as.addrs.length,fv) >= 0;
    if (fn == 'maxN')
      return cmpn(as.addrs.length,fv) <= 0;
    if (fn == 'eqdata' && as.dataHex) {
      var ofs = filters.dataoffset ? filters.dataoffset : 0;
      return as.dataHex.substr(ofs,fv.length) == fv;
    }
    return false;
  }
  function match( o ) {
    for( var n in filters )
      if (!match1( o, n, filters[n], filters ))
        return false;
    return true;
  }
  function okout( out ) {
    var v = Bitcoin.Util.valueToBigInt( out.out.value );
    var as = out.out.script.getOutAddrs();
    ret.outsStats.push( 
                 { value:v,
                   txHash:out.tx.hash,
                   index:out.index,
                   date:out.tx.timestamp,
                   descr:as.descr,
                   N:as.addrs.length,
                   M:as.m,
                   addrs:as.addrs,
                   'unconfirmed':out.tx.unconfirmed,
                   tx:out.tx, 
                   data:as.dataHex?as.dataHex:"",
                   memo:as.dataText?as.dataText:"" } );
    if (out.tx.unconfirmed)
      ret.unconfirmed.add( v );
  }
  function doout( out ) {
    if (match( out ))
      okout( out );
  }
  function doit( outs ) {
    for( var i=0; i<outs.length; i++ )
      doout( outs[i] );
  }
  //  optimization: go directly to tx if possible
  if (from == 'allOuts' && filters.txHash) {
    var tx = this.txIndex[filters.txHash];
    if (tx)
      if (filters.index != undefined) {
        if (filters.index >= 0 && filters.index < tx.outs.length)
          doout( {out:tx.outs[filters.index], 'tx':tx, index:filters.index} );
      }
      else
        for( var i=0; i<tx.outs.length; i++ )
          doout( {out:tx.outs[i], 'tx':tx, index:i} );
  }
  else
    if (this[from])
      doit( this[from] );
  return ret;
}


/*
  get info about output (see .queryOutputs)
*/
Bitcoin.Wallet.prototype.getOutputStats = function( txhash, indx ) {
  var s = this.queryOutputs( 'allOuts', {txHash:txhash, index:indx } );
  return s ? s.outsStats[0] : null;
}


/*
  determine if output is known spent (pruned)
*/
Bitcoin.Wallet.prototype.isOutputPruned = function( txhash, index ) {
  if (this.prunedOutsIndex[txhash+':'+index])
    return true;
  return false;
}


/*
  select ins matching all filters, ie, 
        'select from INPUTS where filter1 [ AND filter2 [AND ...] ] ]'
    filter: {
      one or more of:
        txHash: <b64>
        refTxHash: <b64> (tx the input points to)
        refTxIndex: <int> (output in refTx the input points to)
        descr: 'Address' | 'Pubkey' | 'Strange'
        addr: <std addr str>
        pub: <hex str of pubkey>
      }
  returns 
    [ { txHash, refTxHash, refTxIndex, addrs[], pubkeys[], tx }, ... ]
    outStats[i].tx is pointer to transaction
*/
Bitcoin.Wallet.prototype.queryInputs = function( filter ) {
  function match1( txhash, inp, fn, fv ) {
    if (fn == 'txHash')
      return fv == txhash;
    if (fn == 'refTxHash')
      return fv == inp.outpoint.hash;
    if (fn == 'refTxIndex')
      return fv == inp.outpoint.index;
    var as = inp.script.getInAddrs();
    if (fn == 'descr')
      return as.descr == fv;
    if (fn == 'addr')
      for( var j=0; j<as.addrs.length; j++ )
        if (as.addrs[j].toString() == fv.toString())
          return true;
    if (fn == 'pub')
      for( var j=0; j<as.pubs.length; j++ )
        if (Crypto.util.hexToBytes(as.pubs[j]) == fv)
          return true;
    return false;
  }
  function match( txhash, inp ) {
    for( var n in filter )
      if (!match1( txhash, inp, n, filter[n] ))
        return false;
    return true;
  }
  var res = [];
  function doinp( h, inp, tx ) {
    if (match( h, inp )) {
      var inst = inp.script.getInAddrs();
      res.push( {txHash:h,
                 refTxHash:inp.outpoint.hash,
                 refTxIndex:inp.outpoint.index,
                 descr:inst.descr,
                 addrs:inst.addrs,
                 pubs:inst.pubs,
                 'tx':tx } );
      return true;
    }
  }
  var only1poss = false;
  function dotx( h, tx ) {
    for( var j=0; j<tx.ins.length; j++ )
      if (doinp( h, tx.ins[j], tx ))
        if (only1poss)
          return true;
  }
  //  optimization: if looking for a particular inp ref, use index to get it
  if (filter.refTxHash && filter.refTxIndex != undefined) {
    var ri = this.inputRefIndex[filter.refTxHash+':'+filter.refTxIndex];
    if (ri)
      doinp( ri.tx.hash, ri.in, ri.tx );
  }
  else
    for( var h in this.txIndex )
      if (dotx( h, this.txIndex[h] ))
        if (only1poss)
          break;
  return res;
}


/*
  regenerate unspentouts, etc. datasets in wallet
*/
Bitcoin.Wallet.prototype.reprocess = function( ) {
  var txi = this.txIndex;
  this.txIndex = {}; this.allOuts = []; this.unspentOuts = [];
  this.exitOuts = []; this.prunedOuts = []; 
  this.prunedOutsIndex = {}; this.inputRefIndex = {};
  this.txCount = 0;
  for( var h in txi )
    this.process2( txi[h], txi[h].unconfirmed, true );
  this.pruneSpentOutputs();
}


/*
  create an unsigned send transaction (see wallet.createSend2);
    result is hashable for signing; returns {tx,selectedOuts[]}
*/
Bitcoin.Wallet.prototype.createSendTxUnsigned = function( 
                                      sendTos, chgTo, fee, excludes ) { 
  //  determine what will be spent
  var s = this.selectOutputs( sendTos, chgTo, fee, false, excludes );
  if (s.insufficientFunds)
    throw new Error( "Insufficient funds" );
  //  build tx
  var sendTx = new Bitcoin.Transaction();
  for ( var i=0; i<s.selectedOuts.length; i++ )
    sendTx.addInput( s.selectedOuts[i].tx, s.selectedOuts[i].index );
  for( i=0; i<sendTos.length; i++ )
    sendTx.addOutput2( sendTos[i] );
  if (chgTo.value.compareTo(BigInteger.ZERO) > 0)
    sendTx.addOutput2( chgTo );
  return {tx:sendTx,selectedOuts:s.selectedOuts};
}


/*
  sign a send transaction (see wallet.createSend2)
*/
Bitcoin.Wallet.prototype.signSendTx = function( sendTx, selectedOuts, keys ) { 
  if (keys)
    this.resetToKeyWallet( keys );
  try {
    for( var i=0, scr; i<sendTx.ins.length; i++ ) {
      scr = this.createInputScript( sendTx, selectedOuts[i].out.script, i );
      sendTx.ins[i].script = scr;
    }
  }
  catch( e ) {
    sendTx = null;
  }
  if (keys)
    this.resetAddrWallet();
  return sendTx;
}


/*
  sign a send transaction's input (see wallet.createSend2)
  return false if fail (such as key needed not in wallet)
*/
Bitcoin.Wallet.prototype.signSendTxInput = function( sendTx, selectedOuts, i ) { 
  try {
    sendTx.ins[i].script = 
           this.createInputScript( sendTx, selectedOuts[i].out.script, i );
  }
  catch( e ) {
    return false;
  }
  return true;
}


/*
  (internal fun) stepper for async createSendTx
*/
Bitcoin.Wallet.__sendTxProcesses = {nextpid:1,delay:100};
Bitcoin.Wallet.__sendTxStep = function( pid ) {
  var p = Bitcoin.Wallet.__sendTxProcesses[pid];
  if (p) {
    if (!p.wallet.signSendTxInput( p.sendTx, p.selectedOuts, p.i )) {
      if (p.keysReset)
        p.wallet.resetAddrWallet();
      p.callback( "fail", p.wallet, p.sendTx, p.i, p.sendTx.ins.length );
      delete Bitcoin.Wallet.__sendTxProcesses[pid];
      return;
    }
    p.i++;
    if (p.i < p.sendTx.ins.length) {
      if (p.callback( "progress", p.wallet, p.sendTx, p.i, p.sendTx.ins.length )) {
        delete Bitcoin.Wallet.__sendTxProcesses[pid];
        return;
      }
      setTimeout( 'Bitcoin.Wallet.__sendTxStep('+pid+')', 
                  Bitcoin.Wallet.__sendTxProcesses.delay );
    }
    else {
      if (p.keysReset)
        p.wallet.resetAddrWallet();
      p.callback( "complete", p.wallet, p.sendTx, p.i, p.sendTx.ins.length );
      delete Bitcoin.Wallet.__sendTxProcesses[pid];
    }
  }
}


/*
  start async process for signing a send transaction
*/
Bitcoin.Wallet.prototype.signSendTxAsync = function( 
                              sendTx, selectedOuts, keys, callback ) { 
  if (keys)
    this.resetToKeyWallet( keys );
  var pid = Bitcoin.Wallet.__sendTxProcesses.nextpid.toString();
  Bitcoin.Wallet.__sendTxProcesses.nextpid++;
  Bitcoin.Wallet.__sendTxProcesses[pid] =
                 {wallet:this,'sendTx':sendTx, 'callback':callback,
                  'selectedOuts':selectedOuts,i:0,keysReset:keys?true:false};
  callback( "progress", this, sendTx, 0, sendTx.ins.length );
  setTimeout( 'Bitcoin.Wallet.__sendTxStep('+pid+')', 
              Bitcoin.Wallet.__sendTxProcesses.delay );
}


/*
  sign a tx hash with key from wallet matching addr
*/
Bitcoin.Wallet.prototype.createInputSig = function( txhash, addr, hashType ) {
  if (!this.hasHash( addr.hash ))
    return null;
  var sig = this.signWithKey( addr.hash, txhash );
  sig.push( parseInt(hashType,10) );
  return sig;
}


/*
  create a signed input script for a new spend tx w multisig support, 
    (multisig writes:  OP_0 <sig> <sig> ...)
*/
Bitcoin.Wallet.prototype.createInputScript = function( sendTx, conScr, i ) {
  var newScr = new Bitcoin.Script();
  var hashType = 1; //SIGHASH_ALL
  var txhash = sendTx.hashTransactionForSignature( conScr, i, hashType );
  var a = conScr.getOutAddrs();
  if (a.descr == 'Multisig')
    newScr.writeOp( Bitcoin.Opcode.map.OP_0 );
  for( var j=0,m=0,sig; j<a.addrs.length && m<a.m; j++ ) {
    sig = this.createInputSig( txhash, a.addrs[j], hashType );
    if (sig) {
      newScr.writeBytes( sig );
      if (a.descr == 'Address')
        newScr.writeBytes( this.getPubKeyFromHash(a.addrs[j].hash) );
      m++;
    }
  }
  if (a.m != m)
    throw new Error( "Required key(s) not in wallet" );
  return newScr;
}


/*
  determine if an output script can be spent by this wallet
    (ie, determine if M is satisfied by addrs in wallet)
*/
Bitcoin.Wallet.prototype.isOutputScriptSpendable = function( scr ) {
  var a = scr.getOutAddrs();
  if (a.m)
    for( var j=0,m=0; j<a.addrs.length; j++ )
      if (this.hasHash( a.addrs[j].hash )) {
        m++;
        if (m == a.m)
          return true;
      }
  return false;
}


/*
  prune spent outputs
*/
Bitcoin.Wallet.prototype.pruneSpentOutputs = function() {
  function _prune( outs ) {
    var nouts = [];
    for( var i=0,uo,inp; i<outs.length; i++ ) {
      uo = outs[i];
      //inp = w.queryInputs( {refTxHash:uo.tx.hash,refTxIndex:uo.index} );
      //if (inp.length > 0)
      // (make this faster)
      if (w.inputRefIndex[uo.tx.hash+':'+uo.index])
        w.prunedOuts.push( uo ), w.prunedOutsIndex[uo.tx.hash+':'+uo.index] = uo;
      else
        nouts.push( uo );
    }
    return nouts;
  }
  var w = this;
  if (!this.prunedOuts) this.prunedOuts = [], this.prunedOutsIndex = {};
  this.unspentOuts = _prune( this.unspentOuts );
  this.exitOuts = _prune( this.exitOuts );
}


/*
  attempt to find pubkeys[] for addrs[] by searching wallet data
    TO DO
*/
Bitcoin.Wallet.prototype.findPubKeys = function( addrs ) {
  var pubkeys = [];
  for( var i=0,found=0; i<addrs.length; i++ ) {
    //search input scripts
    //search multisig, pubkey outputs
  }
  return {"pubkeys":pubkeys,numfound:found};
}


/*
  get tx from hash
*/
Bitcoin.Wallet.prototype.getTx = function( txh ) {
  return this.txIndex[txh];
}


/*
  Bitcoin.Script extensions
  -------------------------
*/

/*
  replacement for extractAddresses 
    returns {descr:      'Address'|'Multisig'|'Pubkey'|'Data',
             addrs:[],   addrs in multisig, addrs[0] is pay to addr if std out
             m:<M>,      M from multisig or 1 if std out
             dataHex:<>, if 'Data', hex string of data
             dataText:<>} if 'Data', text of data
*/
Bitcoin.Script.prototype.getOutAddrs = function() {
  var ret = {descr:this.getOutType(),addrs:[],addrstrs:[],m:1};
  var a;
  switch( ret.descr ) {
    case 'Address':
      a = Bitcoin.Address.validate( this.chunks[2] );
      if (a)
        ret.addrs.push(a), ret.addrstrs.push(a.toString());
      break;
    case 'Pubkey':
      a = Bitcoin.Address.fromPubKey( this.chunks[0] );
      if (a)
        ret.addrs.push(a), ret.addrstrs.push(a.toString());
      break;
    case 'Multisig':
      for( var i=1; i<this.chunks.length-2; i++ ) {
        a = Bitcoin.Address.fromPubKey( this.chunks[i] );
        if (a)
          ret.addrs.push(a), ret.addrstrs.push(a.toString());
      }
      ret.m = this.chunks[0] - Bitcoin.Opcode.map.OP_1 + 1;
      break;
    case 'Data':
      ret.dataHex = Crypto.util.bytesToHex( this.chunks[1] );
      ret.dataText = Bitcoin.Util.bytesToString( this.chunks[1] );
      ret.m = 0;
      break;
    default:
      ret.m = 0;
  }
  return ret;
}


/*
  override of simpleOutHash, returns impossible matching hash 
  for non-simple types 
  (this is to prevent bitcoinjs-lib from throwing exceptions)
*/
Bitcoin.Script.prototype.simpleOutHash = function () {
  switch (this.getOutType()) {
    case 'Address':
      return this.chunks[2];
    case 'Pubkey':
      return Bitcoin.Util.sha256ripe160(this.chunks[0]);
    default:
      return Crypto.util.randomBytes( 20 );
  }
}
Bitcoin.Script.prototype.simpleOutPubKeyHash =
                           Bitcoin.Script.prototype.simpleOutHash;


/*
  get input script's addresses from pubkeys, only works for std in
  returns {descr:'Address',addrs:[],pubs:[]};
*/
Bitcoin.Script.prototype.getInAddrs = function () {
  var ret = {descr:this.getInType(),addrs:[],pubs:[]};
  if (ret.descr == 'Address')
    ret.pubs.push( this.simpleInPubKey() ),
    ret.addrs.push( Bitcoin.Address.fromPubKey(this.simpleInPubKey()) );
  return ret;
}


/*
  override of getOutType in bitcoinjs (script.js),
    patch for detecting properly formed multisig, also support for 'Data'
*/
Bitcoin.Script.prototype.getOutType__ = Bitcoin.Script.prototype.getOutType;
Bitcoin.Script.prototype.getOutType = function () {
  var l = this.chunks.length;
  if (l == 2 && this.chunks[0] == Bitcoin.Opcode.map.OP_RETURN)
    return 'Data';
  else
    if (l >= 4)
      if (this.chunks[l-1] == Bitcoin.Opcode.map.OP_CHECKMULTISIG) {
        var n_expected = l - 3;
        var m = this.chunks[0] - Bitcoin.Opcode.map.OP_1 + 1;
        var n = this.chunks[l-2] - Bitcoin.Opcode.map.OP_1 + 1;
        if (n == n_expected)
          if (/*n <= 3 &&*/ m <= n)
            return 'Multisig';
      }
  return this.getOutType__();
}


/*
  Create a data output script, OP_RETURN <data (up to 40 bytes)>
*/
Bitcoin.Script.createDataOutputScript = function( Data ) {
  if (typeof(Data) == 'string')
    Data = Crypto.util.hexToBytes( Data );
  else
    if (Data.memo)
      Data = Bitcoin.Util.stringToBytes( Data.memo );
  var script = new Bitcoin.Script();
  script.writeOp( Bitcoin.Opcode.map.OP_RETURN );
  //while (Data.length < 40) Data.push( 0 );
  if (Data.length > 40)
    throw new Error( "Data output exceeds 40 bytes" );
  script.writeBytes( Data );
  return script;
}
Bitcoin.Util.stringToBytes = function( str ) {
  for( var bytes=[],i=0; i<str.length; i++ )
    bytes.push( str.charCodeAt(i) );
  return bytes;
}
Bitcoin.Util.bytesToString = function( bytes ) {
  for( var str="",i=0; i<bytes.length; i++ )
    str += String.fromCharCode( bytes[i] );
  return str;
}


/*
  Bitcoin.Transaction extensions
  ------------------------------
*/

/*
  new version of addOutput w multisig support, takes:
    { value:<BigInteger>|<float string>, 
      "Address": <addr> | <std str> 
      [or] "Multisig": { pubkeys:[], M:<M of N> }
      [or] "Data": <bytearr or hex str (40 bytes max)> }
  if "Address" defined, creates std pay output to Address
  if "Multisig" defined, Multisig.pubkeys[] are the N keys
       and M is Multisig.M, each pubkey is <pubkey> | <hex string> 
    writes:  OP_<M> <pubkey>...<pubkey> OP_<N> OP_CHECKMULTISIG
  if "Data" defined, creates data output
    writes:  OP_RETURN <data>
    if Data.memo defined, Data.memo is a char string
*/
Bitcoin.Transaction.prototype.addOutput2 = function( sendTo ) {
  var value = sendTo.value ? sendTo.value : "0.00";
  if (!Bitcoin.Util.isArray( value )) {
    value = Bitcoin.Util.parseValue2( value );
    value = value.toByteArrayUnsigned().reverse();
    while (value.length < 8) value.push(0);
  }
  var scr;
  if (sendTo.Multisig) {
    var pubkeys = Bitcoin.Util.hexesToBytes( sendTo.Multisig.pubkeys );
    scr = Bitcoin.Script.createMultiSigOutputScript( 
                                            sendTo.Multisig.M, pubkeys );
  }
  else
    if (sendTo.Data)
      scr = Bitcoin.Script.createDataOutputScript( sendTo.Data );
    else
      scr = Bitcoin.Script.createOutputScript( 
                                   Bitcoin.Address.validate(sendTo.Address) );
  this.outs.push( new Bitcoin.TransactionOut({value:value,script:scr}) );
}


/*
  get float str of value field in a SEND transaction
*/
Bitcoin.Util.sendTxValueToStr = function( v ) {
  var bytes = v.slice( 0 );
  return Bitcoin.Util.formatValue( bytes.reverse() );
}
Bitcoin.Transaction.prototype.valueToStr = function(v) 
  {return Bitcoin.Util.sendTxValueToStr(v);}


/*
  bitcoinjs-lib quirk: value bytes are stored in reverse 
  order when used by a wallet as opposed to in a send tx
*/
Bitcoin.Transaction.prototype.reverseOutVals = function( ) {
  for( var i=0,bytes; i<this.outs.length; i++ ) {
    bytes = this.outs[i].value.slice( 0 );
    this.outs[i].value = bytes.reverse();
  }
}


/*
  make a walletable version of a send tx
*/
Bitcoin.Transaction.prototype.convertFromSend = function( ) {
  var newtx = this.clone();
  newtx.hash = Crypto.util.bytesToBase64( newtx.getHash() );
  newtx.reverseOutVals();
  return newtx;
}


/*
  convert a wallet tx to its send form for hashing, validation
*/
Bitcoin.Transaction.prototype.convertToSend = function( ) {
  var newtx = this.clone();
  newtx.reverseOutVals();
  newtx.hash = Crypto.util.bytesToBase64( newtx.getHash() );
  return newtx;
}


/*
  get tx hash
*/
Bitcoin.Transaction.prototype.calcHash = function( isSend ) {
  if (isSend)
    return Crypto.util.bytesToBase64( this.getHash() );
  var newtx = this.convertToSend();
  return newtx.hash;
}


/*
  make a walletable version of tx, see wallet.addTx
*/
Bitcoin.Transaction.prepForWallet = function( tx, isSend, noVerify ) {
  var h = tx.hash;
  var newtx;
  if (!(tx instanceof Bitcoin.Transaction)) {
    newtx = new Bitcoin.Transaction( tx );
    if (!newtx.hash || !noVerify)
      newtx.hash = newtx.calcHash();
  }
  else
    if (isSend)
      newtx = tx.convertFromSend();
    else {
      newtx = tx.convertToSend();
      newtx = newtx.convertFromSend();
    }
  if (h)
    if (noVerify)
      newtx.hash = h;
    else
      if (h != newtx.hash)
        throw new Error( "Transaction hash validation failed" );
  return newtx;
}


/*
  Bitcoin.Address, Bitcoin.Util, Bitcoin.ECKey extensions
  -------------------------------------------------------
*/

/*
  process a std private key string or passphrase into 
    { key:<ECKey>, 
      address:<Bitcoin.Address>, 
      addressStr:<std str>, //helpful when debugging
      privateStr:<std str>, 
      pubHex:<str>, 
      h160hex:<str>, 
      pass:<str> }
  privOrPass: 
    if not provided, random key is generated
      if dictCallback, Bitcoin.ECKey.randPass is called to make the random
    if not recognized as std private key, assumed to be pass
*/
Bitcoin.Address.fromPrivOrPass = function( privOrPass, dictCallback ) {
  if (privOrPass && typeof(privOrPass) != 'string')
    return null;
  var ret = {key:null, a:null, addr:"", priv:privOrPass, pass:""};
  if (!privOrPass && dictCallback)
    privOrPass = Bitcoin.ECKey.randPass( dictCallback );
  if (!privOrPass)
    ret.key = new Bitcoin.ECKey();
  else
    ret.key = Bitcoin.ECKey.validatePrivStr( privOrPass );
  if (!ret.key) { 
    //treat as pass (single sha256 for compatibility with brainwallets)
    var hash = Crypto.SHA256( privOrPass, {asBytes:true} );
    ret.pass = privOrPass;
    ret.ispass = true;
    ret.key = Bitcoin.ECKey.fromPriv( hash );
  }
  if (ret.key) {  //(some deprecated names for backward compatibility)
    ret.ecKey = ret.key;
    ret.priv = ret.privateStr = ret.key.getExportedPrivateKey();
    ret.a = ret.address = ret.key.getBitcoinAddress(); 
    ret.addr = ret.addressStr = ret.a.toString();
    ret.h160hex = Crypto.util.bytesToHex( ret.a.hash );
    ret.pub = ret.pubHex = Crypto.util.bytesToHex( ret.key.getPub() );
  }
  else
    ret = null;
  return ret;
}


/*
  validate an std address string, addr obj, or addr hash, 
    return null if no good
*/
Bitcoin.Address.validate = function( addrOrHashOrStr ) {
  if (addrOrHashOrStr instanceof Bitcoin.Address)
    addrOrHashOrStr = addrOrHashOrStr.toString(); //(make copy)
  var a;
  try {
    a = new Bitcoin.Address( addrOrHashOrStr );
  }
  catch (err) {
    a = null;
  }
  return a;
}


/*
  convert a pubkey hex string or bytearray to bitcoin address
*/
Bitcoin.Address.fromPubKey = function( pubKey ) {
  if (typeof(pubKey) == 'string')
    pubKey = Crypto.util.hexToBytes( pubKey );
  return Bitcoin.Address.validate( Bitcoin.Util.sha256ripe160(pubKey) );
}


/*
  convert a pubkey hex string or bytearray to bitcoin address
*/
Bitcoin.Address.validatePubKey = function( pubKey ) {
  if (!pubKey)
    return null;
  if (typeof(pubKey) == 'string') {
    var p2 = pubKey.replace( /[^a-f0-9+\/]/ig, "" );
    if (pubKey != p2 || pubKey.length != 130)
      return null;
    pubKey = Crypto.util.hexToBytes( pubKey );
  }
  if (pubKey.length != 65)
    return null;
  return Bitcoin.Address.validate( Bitcoin.Util.sha256ripe160(pubKey) );
}


/*
  get hash of addr obj or addr string
*/
Bitcoin.Address.getHashBytes = function( addr ) {
  if (addr instanceof Bitcoin.Address)
    return addr.hash;
  var a = Bitcoin.Address.validate( addr );
  if (!a)
    throw new Error( "Invalid address string or obj" );
  return a.hash;
}


/*
  find index of addr in addr array
*/
Bitcoin.Address.prototype.findIn = function( addrArr ) {
  var as = this.toString();
  if (addrArr)
    for( var i=0; i<addrArr.length; i++ )
      if (as == addrArr[i].toString())
        return i;
  return -1;
}


/*
  create an address with optional attached metadata
*/
Bitcoin.Address.create = function( addr, metadata ) {
  var a = Bitcoin.Address.validate( addr );
  if (a)
    a.setMetaData( metadata );
  return a;
}


/*
  get/set address metadata
*/
Bitcoin.Address.prototype.setMetaData = function( metadata ) {
  this.metaData = metadata;
}
Bitcoin.Address.prototype.getMetaData = function( ) {
  return this.metaData;
}


/*
  Mine an address matching one of '1<matches[i]>*'
    callback( 'progress'|'complete', step, Keyinfo )
      callback returns true to cancel
    dictCallback(byteArray) see Bitcoin.Address.fromPrivOrPass
    delay: millisecond delay between callbacks, default 250
  TODO: add regexp support
*/
Bitcoin.Address.mine = function( matches, callback, dictCallback, delay ) { 
  if (!delay) delay = Bitcoin.Address.__minerProcesses.defaultdelay;
  var pid = Bitcoin.Address.__minerProcesses.nextpid.toString();
  Bitcoin.Address.__minerProcesses.nextpid++;
  Bitcoin.Address.__minerProcesses[pid] = 
                     {'matches':matches,
                      'callback':callback,
                      dict:dictCallback,
                      i:-1,
                      'delay':delay};
  callback( "progress", 0 );
  setTimeout( 'Bitcoin.Address.__minerStep('+pid+')', 1 );
}


/*
  (internal fun) stepper for address miner
*/
Bitcoin.Address.__minerProcesses = {nextpid:1,defaultdelay:250};
Bitcoin.Address.__minerStep = function( pid ) {
  var p = Bitcoin.Address.__minerProcesses[pid];
  if (p) {
    function isin( k, ma ) {
      for( var i=0; i<ma.length; i++ )
        if (ma[i] && k.a.toString().substr(1,ma[i].length) == ma[i])
          return true;
    }
    var step = (new Date().valueOf()) + p.delay, cur, k;
    while (1) {
      p.i++;
      k = Bitcoin.Address.fromPrivOrPass( "", p.dict );
      if (isin( k, p.matches )) {
        p.callback( "complete", p.i, k );
        delete Bitcoin.Address.__minerProcesses[pid];
        break;
      }
      else {
        cur = (new Date()).valueOf();
        if (cur >= step) {
          if (p.callback( "progress", p.i, k ))
            delete Bitcoin.Address.__minerProcesses[pid];
          else
            setTimeout( 'Bitcoin.Address.__minerStep('+pid+')', 1 );
          break;
        }
      }
    }
  }
}


/*
  validate private key, return ECKey or null if no good 
*/
Bitcoin.ECKey.fromPriv = function( priv ) {
  var eckey;
  try {
    eckey = new Bitcoin.ECKey( priv );
  }
  catch (err) {
    eckey = null;
  }
  return eckey;
}


/*
  generate a random passphrase from a dictionary
    p = dictCallback( byteArray ): converts rand bytes to words
    if dictCallback ommitted, rfc1751 dictionary is used
*/
Bitcoin.ECKey.randPass = function( dictCallback ) {
  //(we're trusting ECKey's rand generator - best ?)
  //return dictCallback(Crypto.util.randomBytes(32)).toLowerCase();
  var k = new Bitcoin.ECKey();
  if (!dictCallback && key_to_english)
    if (typeof(key_to_english) == 'function')
      dictCallback = key_to_english;
  return dictCallback(k.priv.toByteArrayUnsigned()).toLowerCase();
}


/*
  validate std private key string, return ECKey or null if no good 
*/
Bitcoin.ECKey.validatePrivStr = function( priv ) {
  //  (prevents bitoinjs from thinking its b64)
  if (typeof(priv) == 'string')
    if (priv.length == 51 && priv[0] == '5')
      return Bitcoin.ECKey.fromPriv( priv );
  return null;
}


/*
  convert float or float str to #of satoshis str
*/
Bitcoin.Util.floatToSatoshis = function( valueString ) {
  if (typeof valueString != 'string')
    valueString = valueString.toString();
  var valueComp = valueString.split('.');
  var integralPart = valueComp[0];
  var fractionalPart = valueComp[1] || "0";
  while (fractionalPart.length < 8) fractionalPart += "0";
  valueString = integralPart + fractionalPart;
  valueString = (new BigInteger(valueString,10)).toString(10);
  return valueString;
}
// (better name)
Bitcoin.Util.floatToSatoshisStr = Bitcoin.Util.floatToSatoshis;


/*
  convert #of satoshis str or int to float str
*/
Bitcoin.Util.satoshisToFloatStr = function( value ) {
  if (typeof value != 'string')
    value = value.toString();
  var fl = value.length>8 ? 8 : value.length;
  var il = value.length - fl;
  var fp = value.substr( il, fl );
  while (fp.length < 8) fp = '0' + fp;
  value = value.substr( 0, il );
  value = (value?value:'0') + '.' + fp;
  var newv = Bitcoin.Util.formatValue2( Bitcoin.Util.parseValue2(value) );
  return newv;
}


/*
  convert BigInteger or float str to BigInteger
*/
Bitcoin.Util.parseValue2 = function( value ) {
  value = value ? value : "0.00";
  if (value instanceof BigInteger)
    return value;
  return Bitcoin.Util.parseValue( value );
}


/*
  convert BigInteger or float str to formatted str
*/
Bitcoin.Util.formatValue2 = function( value ) {
  if (typeof value == 'string')
    value = Bitcoin.Util.parseValue2( value );
  return Bitcoin.Util.formatValue( value );
}


/*
  convert hex strs to byte, if needed
*/
Bitcoin.Util.hexesToBytes = function( hexs ) {
  var v = [];
  for( var i=0; i<hexs.length; i++ )
    if (typeof hexs[i] == 'string')
      v[i] = Crypto.util.hexToBytes( hexs[i] );
    else
      v[i] = hexs[i];
  return v;
}


if (Bitcoin.Message) {
/*
  sign message with private key str or passphrase
*/
Bitcoin.Message.sign = function( privOrPass, message, /*opt*/keyinfo ) {
  var sig = null;
  if (!keyinfo)
    keyinfo = Bitcoin.Address.fromPrivOrPass( privOrPass );
  sig = Bitcoin.Message.signMessage( 
                   keyinfo.key, message, keyinfo.key.compressed );
  return sig;
}
/*
  A version of Bitcoin.Message.verifyMessage that returns 
  whatever pubkey the signature resolves to
*/
Bitcoin.Message.verifyTo = function( sig, message ) {
  sig = Crypto.util.base64ToBytes( sig );
  sig = Bitcoin.ECDSA.parseSigCompact( sig );
  var hash = Bitcoin.Message.getHash( message );
  var isCompressed = !!(sig.i & 4);
  var pubKey = Bitcoin.ECDSA.recoverPubKey( sig.r, sig.s, hash, sig.i );
  pubKey.setCompressed( isCompressed );
  return pubKey;
}
}


