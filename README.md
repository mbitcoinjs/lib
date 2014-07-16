mbitcoinjs-lib
===

v0.0.2 (July 15, 2014) adds JSON import from blockr.io (BIO), wallet sync, and push transaction capabilities.

Note that this extension is for the original bitcoinjs-lib version 0.1.3 (provided in the extern subdir).  Most of the Javascript bitcoin projects in production use the original bitcoinjs-lib (the original has been stable and widely used for a few years).

Demo page: <a href="http://mbitcoinjs.github.io/lib/demo.html">http://mbitcoinjs.github.io/lib/demo.html</a>


<h4>About mbitcoinjs-lib</h4>

 - Extensions to bitcoinjs-lib v0.1.3 for multi-signature, data/memo outputs, brainwallet passphrases, JSON import/export, network sync
 - inherits bitcoinjs-lib v0.1.3 license (refer to bitconjs-min.js in extern subdir)

mbitcoinjs-lib extends the bitcoinjs-lib v0.1.3 bitcoin/crypto javascript library; it is designed to provide its extended functions without interfering with any pre-existing code that calls into bitcoinjs-lib.

- Additions to <code>Bitcoin.Wallet</code> namespace for multisig awareness and searching output datasets.

- Creates transactions with multisig and data/memo outputs.

- Recognizes multisig as spendable if the required M addresses are in the wallet, signs/spends with M keys. 
    
- Additions to <code>Bitcoin.Address</code> namespace for brainwallet passphrase support, also vanity address miner.

- Namespace <code>Bitcoin.ImpExp</code> for importing/exporting data in BBE/BCI/BIO JSON text formats to/from wallets (some of this code adapted from <a href="http://brainwallet.org">brainwallet.org</a>).

- <code>Bitcoin.ImpExp.Sync</code> for downloading transactions into wallets, also new transaction broadcast



<h4>Doc in source</h4>


Some projects that use this extension: 

<a href="http://rarebit.github.io/project/client/web1">Rarebit web client</a>

<a href="http://thoughtwallet.github.io/wallet/">ThoughtWallet</a> (uses v0.0.1 alpha)
