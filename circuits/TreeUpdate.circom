include "./MerkleTreeUpdater.circom";

// zeroLeaf = keccak256("tornado") % FIELD_SIZE
component main = MerkleTreeUpdater(3, 21663839004416932945382355908790599225266501822907911457504978515578255421292);
