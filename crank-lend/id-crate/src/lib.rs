use anchor_lang::prelude::*;

cfg_if::cfg_if! {
    if #[cfg(feature = "mainnet-beta")] {
        declare_id!("GAWPC7CS46St5BxsuicijpzSG4GRWf6csaPvKRdZb314");
    } else if #[cfg(feature = "devnet")] {
        declare_id!("GAWPC7CS46St5BxsuicijpzSG4GRWf6csaPvKRdZb314");
    } else if #[cfg(feature = "staging")] {
        declare_id!("GAWPC7CS46St5BxsuicijpzSG4GRWf6csaPvKRdZb314");
    } else if #[cfg(feature = "stagingalt")] {
        declare_id!("GAWPC7CS46St5BxsuicijpzSG4GRWf6csaPvKRdZb314");
    } else {
        declare_id!("GAWPC7CS46St5BxsuicijpzSG4GRWf6csaPvKRdZb314");
    }
}
