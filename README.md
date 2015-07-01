mbitcoinjs-lib
===

v0.0.3 (July 1, 2015)


mbitcoinjs-lib extends the bitcoinjs-lib 0.1.3 bitcoin/crypto javascript library (inherits license - refer to bitconjs-min.js in extern subdir).

Demo page: <b><a href="http://mbitcoinjs.github.io/lib/demo.html">http://mbitcoinjs.github.io/lib/demo.html</a></b>


<h4>Overview</h4>

- Additions to <code>Bitcoin.Wallet</code> namespace for multisig awareness and searching output datasets.

- Creates transactions with multisig and data/memo outputs.

- Recognizes multisig as spendable if the required M addresses are in the wallet, signs/spends with M keys. 
    
- Additions to <code>Bitcoin.Address</code> namespace for brainwallet passphrase support, also vanity address miner;  generates random word passphrases from rfc1751 or user supplied dictionary.

- Namespace <code>Bitcoin.ImpExp</code> for importing/exporting JSON transaction data; BBE/BCI/BIO formats are supported (auto-detected on import).

- <code>Bitcoin.ImpExp.Sync</code> for downloading JSON data into wallets, also transaction broadcast.


The network functions do not require server compenents be installed or that users run bitcoind. The network functions connect to and pull data from blockr.io (BIO), blockexplorer.com (BBE), or blockchain.info (BCI).  BIO is the default since its address API returns multi-signature transactions that contain the target address (see demo for an example of a multisig wallet).

<h4>Doc in source</h4>


Some projects that use this extension: 

<a href="http://rarebit.github.io/project/">Rarebit web client</a>

<a href="http://thoughtwallet.github.io/wallet/">ThoughtWallet</a> (uses v0.0.1 alpha)
