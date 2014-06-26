mbitcoinjs-lib
===

 - Extensions to bitcoinjs-lib for multi-signature, data/memo outputs, brainwallet passphrases, JSON import/export
 - v0.0.1, early beta, inherits bitcoinjs-lib license

mbitcoinjs-lib extends the bitcoinjs-lib bitcoin/crypto javascript library; it is designed to provide its extended functions without interfering with any pre-existing code that calls into bitcoinjs-lib.

- Creates transactions with multisig and data/memo outputs

- Recognizes multisig as spendable if the required M addresses are in the wallet, signs/spends with M keys. 
    
- Additions to <code>Bitcoin.Address</code> namespace for brainwallet passphrase support, also vanity address miner.

- New namespace <code>Bitcoin.ImpExp</code> for importing/exporting data in BBE/BCI JSON text formats to/from wallets (code adapted from <a href="http://brainwallet.org">brainwallet.org</a>).


<h5>IMPORTANT: Current bitcoin client will not allow the throwaway opcode in a multisig redemption to be anything other than OP_0.
This older code is using OP RESERVED, so the effected code in mbitcoinjs.js should be edited (minor change).  
In addition, the correct opcode for data/memo outs is OP_RETURN with a 40 byte maximum.</h5>

<h3>Doc in source</h3>
