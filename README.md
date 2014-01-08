mbitcoinjs-lib
===

 - Extensions to bitcoinjs-lib for multi-signature, data/memo outputs, brainwallet passphrases, JSON import/export
 - v0.0.1, early beta, inherits bitcoinjs-lib license

mbitcoinjs-lib is an addon to the bitcoinjs-lib bitcoin/crypto javascript library.  The .js files can be included after bitcoinjs-min.js in a project's HTML file to make the extended functionality available.  mbitcoinjs-lib is designed to not interfere with any pre-existing code that calls into bitcoinjs-lib.


<h3>Overview</h3>

  Additions to <code>Bitcoin.Wallet</code>, <code>Bitcoin.Transaction</code>, <code>Bitcoin.Script</code> namespaces to support multi-signature and data/memo outputs.
  
    Creates transactions containing multisig (M of N) and data outputs ("OP_RESERVED <80 bytes>").

    Recognizes multisig as spendable if the required M addresses are in the wallet, signs/spends with M keys. 
    
  Additions to <code>Bitcoin.Address</code> namespace for brainwallet passphrase support, also vanity address miner.

  New namespace <code>Bitcoin.ImpExp</code> for importing/exporting data in BBE/BCI JSON text formats to/from wallets (code adapted from <a href="http://brainwallet.org">brainwallet.org</a>).



<h3>Some primary functions (doc in source)</h3>

 - <code>Bitcoin.Wallet.createSend2()</code>: new version of createSend with multisig and data output support, also supports multiple outputs and async mode.

 - <code>Bitcoin.Wallet.selectOutputs()</code>: determines which spendables will be redeemed for a pending spend transaction and calcs helpful stats.

 - <code>Bitcoin.Wallet.queryOutputs()</code>: searches an output dataset.

 - <code>Bitcoin.Address.fromPrivOrPass()</code>: resolves a private key or brainwallet passphrase into address/pubkey/etc data structure, also makes random passphrases from user supplied or rfc1751 dictionary.

 - <code>Bitcoin.ImpExp.BBE.import()</code>: imports BBE/BCI JSON text data into a wallet.

 - <code>Bitcoin.ImpExp.BBE.export()</code>: exports wallet to BBE text.


<h3>Some projects that use mbitcoinjs-lib</h3>

  ThoughtWallet: <a href="http://thoughtwallet.github.io/wallet">http://thoughtwallet.github.io/wallet</a>
  
  Rarebit client: <a href="http://rarebit.github.io/project/client/min">http://rarebit.github.io/project/client/min</a>
