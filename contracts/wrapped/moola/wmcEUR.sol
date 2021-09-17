// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "./WrappedMToken.sol";

contract wmcEUR is WrappedMToken {
  constructor(address _mToken, address _token, address _lendingPool)
    WrappedMToken("Wrapped mcEUR", "wmcEUR", _mToken, _token, _lendingPool)
  {}
}

