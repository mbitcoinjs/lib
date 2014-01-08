//
//Importer/exporter for bitcoin transaction data in various formats;
//  builds wallet from imported data (public domain)
//
//BlockExplorer/BlockChain data implementation (adapted from BrainWallet)
//
//  status = Bitcoin.ImpExp.BBE.import( textJSON, wallet )
//    status: {txsRejected:<>,txsAccepted:<>}
//
//  status = Bitcoin.ImpExp.BBE.export( wallet )
//    status: {text:<JSON>,txsRejected:<>,txsAccepted:<>}
//
//  Bitcoin.ImpExp.BBE.import auto-detects whether BCI or BBE data
//    http://blockchain.info/unspent?address=<address>
//    http://blockexplorer.com/q/mytransactions/<address>
//
Bitcoin.ImpExp = {};

Bitcoin.ImpExp.Processor = function( imp, exp, onProgress, strict ) {
  this.importNextTx = imp;
  this.exportNextTx = exp;
  this.onProgress = onProgress;
  this.relaxedValidation = !strict;
}

Bitcoin.ImpExp.Processor.prototype.importAll = function( text, wallet ) {
  var r = {txsRejected:0,txsAccepted:0};
  if (!wallet || text == "")
    return r;
  do {
    if (this.onProgress)
      this.onProgress( r.txsAccepted+r.txsRejected );
    r.res = this.importNextTx( text, wallet, this );
    if (!r.res.allinvalid && !r.res.complete)
      r.res.tx ? r.txsAccepted++ : r.txsRejected++;
  }
  while( !r.res.allinvalid && !r.res.complete );
  if (r.txsAccepted)
    wallet.reprocess();
  return r.res.allinvalid ? null : r;
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
BlockExplorer/BlockChain data implementation
*/
Bitcoin.ImpExp.BBE = {};
Bitcoin.ImpExp.BCI = {};

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
          if (!n)
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

Bitcoin.ImpExp.BBE.importstart = function( txsX, Jthis ) {
  for( var h in txsX )
    Jthis.txs.push( txsX[h] );
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
    if (Jthis.txi < Jthis.txs.length) {
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

Bitcoin.ImpExp.BBE.export = function( wallet, onProgress ) {
  var p = Bitcoin.ImpExp.BBE.create( onProgress );
  return p.exportAll( wallet );
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

