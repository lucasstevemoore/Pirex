import { expect } from 'chai';
import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { uniq } from 'lodash';
import { callAndReturnEvents, validateEvent } from './helpers';
import { PirexFees } from '../typechain-types';

describe('PirexFees', function () {
  let admin: SignerWithAddress;
  let notAdmin: SignerWithAddress;
  let treasury: SignerWithAddress;
  let contributors: SignerWithAddress;
  let pirexFees: PirexFees;

  let zeroAddress: string;
  let feeDistributorRole: string;
  let adminRole: string;

  const feeRecipientEnum = {
    treasury: 0,
    contributors: 1,
  };

  before(async function () {
    ({ admin, notAdmin, treasury, contributors, pirexFees, zeroAddress } =
      this);
  });

  describe('initial state', function () {
    it('Should have predefined state variables', async function () {
      feeDistributorRole = await pirexFees.FEE_DISTRIBUTOR_ROLE();
      const percentDenominator = await pirexFees.PERCENT_DENOMINATOR();
      const treasuryPercent = await pirexFees.treasuryPercent();
      const contributorsPercent = await pirexFees.contributorsPercent();

      expect(percentDenominator).to.equal(100);
      expect(feeDistributorRole).to.equal(
        ethers.utils.formatBytes32String('FEE_DISTRIBUTOR')
      );
      expect(treasuryPercent).to.equal(75);
      expect(contributorsPercent).to.equal(25);
    });
  });

  describe('constructor', function () {
    it('Should set up contract state', async function () {
      const _treasury = await pirexFees.treasury();
      const _contributors = await pirexFees.contributors();
      adminRole = await pirexFees.DEFAULT_ADMIN_ROLE();
      const adminHasRole = await pirexFees.hasRole(adminRole, admin.address);
      const notAdminHasAdminRole = await pirexFees.hasRole(
        adminRole,
        notAdmin.address
      );
      const notAdminHasDepositorsRole = await pirexFees.hasRole(
        feeDistributorRole,
        notAdmin.address
      );
      const roles = [adminRole, feeDistributorRole];

      expect(_treasury).to.equal(treasury.address);
      expect(_contributors).to.equal(contributors.address);
      expect(adminHasRole).to.equal(true);
      expect(notAdminHasAdminRole).to.equal(false);
      expect(notAdminHasDepositorsRole).to.equal(false);
      expect(uniq(roles).length).to.equal(roles.length);
    });
  });

  describe('grantFeeDistributorRole', function () {
    it('Should revert if distributor is zero address', async function () {
      const invalidDepositor = zeroAddress;

      await expect(
        pirexFees.grantFeeDistributorRole(invalidDepositor)
      ).to.be.revertedWith('ZeroAddress()');
    });

    it('Should revert if called by non-admin', async function () {
      const distributor = notAdmin.address;

      await expect(
        pirexFees.connect(notAdmin).grantFeeDistributorRole(distributor)
      ).to.be.revertedWith(
        `AccessControl: account ${notAdmin.address.toLowerCase()} is missing role ${adminRole}`
      );
    });

    it('Should grant the distributor role to an address', async function () {
      const distributor = notAdmin.address;
      const hasRoleBefore = await pirexFees.hasRole(
        feeDistributorRole,
        distributor
      );
      const [, grantEvent] = await callAndReturnEvents(
        pirexFees.grantFeeDistributorRole,
        [distributor]
      );
      const hasRoleAfter = await pirexFees.hasRole(
        feeDistributorRole,
        distributor
      );

      expect(hasRoleBefore).to.equal(false);
      expect(hasRoleAfter).to.equal(true);
      validateEvent(grantEvent, 'GrantFeeDistributorRole(address)', {
        distributor: notAdmin.address,
      });
    });
  });

  describe('revokeFeeDistributorRole', function () {
    it('Should revert if called by non-admin', async function () {
      const distributor = notAdmin.address;

      await expect(
        pirexFees.connect(notAdmin).revokeFeeDistributorRole(distributor)
      ).to.be.revertedWith(
        `AccessControl: account ${notAdmin.address.toLowerCase()} is missing role ${adminRole}`
      );
    });

    it('Should revoke the fee distributor role from an address', async function () {
      const distributor = notAdmin.address;
      const hasRoleBefore = await pirexFees.hasRole(
        feeDistributorRole,
        distributor
      );
      const [, revokeEvent] = await callAndReturnEvents(
        pirexFees.revokeFeeDistributorRole,
        [distributor]
      );
      const hasRoleAfter = await pirexFees.hasRole(
        feeDistributorRole,
        distributor
      );

      expect(hasRoleBefore).to.equal(true);
      expect(hasRoleAfter).to.equal(false);
      validateEvent(revokeEvent, 'RevokeFeeDistributorRole(address)', {
        distributor,
      });
    });

    it('Should revert if address is not a distributor', async function () {
      const invalidDistributor1 = notAdmin.address;
      const invalidDistributor2 = zeroAddress;
      const distributor1HasRole = await pirexFees.hasRole(
        feeDistributorRole,
        invalidDistributor1
      );

      expect(distributor1HasRole).to.equal(false);
      await expect(
        pirexFees.revokeFeeDistributorRole(invalidDistributor1)
      ).to.be.revertedWith('NotFeeDistributor()');
      await expect(
        pirexFees.revokeFeeDistributorRole(invalidDistributor2)
      ).to.be.revertedWith('NotFeeDistributor()');
    });
  });

  describe('setFeeRecipient', function () {
    it('Should revert if f enum is out of range', async function () {
      const invalidF = feeRecipientEnum.contributors + 1;

      await expect(
        pirexFees.setFeeRecipient(invalidF, admin.address)
      ).to.be.revertedWith(
        'Transaction reverted: function was called with incorrect parameters'
      );
    });

    it('Should revert if recipient is zero address', async function () {
      const f = feeRecipientEnum.treasury;
      const invalidRecipient = zeroAddress;

      await expect(
        pirexFees.setFeeRecipient(f, invalidRecipient)
      ).to.be.revertedWith('ZeroAddress()');
    });

    it('Should revert if not called by admin', async function () {
      const f = feeRecipientEnum.treasury;
      const recipient = admin.address;

      await expect(
        pirexFees.connect(notAdmin).setFeeRecipient(f, recipient)
      ).to.be.revertedWith(
        `AccessControl: account ${notAdmin.address.toLowerCase()} is missing role ${adminRole}`
      );
    });

    it('Should set treasury', async function () {
      const newTreasury = notAdmin.address;
      const treasuryBefore = await pirexFees.treasury();
      const [setEvent] = await callAndReturnEvents(pirexFees.setFeeRecipient, [
        feeRecipientEnum.treasury,
        newTreasury,
      ]);
      const treasuryAfter = await pirexFees.treasury();

      // Revert change to appropriate value for future tests
      await pirexFees.setFeeRecipient(
        feeRecipientEnum.treasury,
        treasuryBefore
      );

      expect(treasuryBefore).to.equal(treasury.address);
      expect(treasuryBefore).to.not.equal(treasuryAfter);
      expect(treasuryAfter).to.equal(notAdmin.address);
      validateEvent(setEvent, 'SetFeeRecipient(uint8,address)', {
        f: feeRecipientEnum.treasury,
        recipient: notAdmin.address,
      });

      // Test change reversion
      expect(treasuryBefore).to.equal(await pirexFees.treasury());
    });

    it('Should set contributors', async function () {
      const newContributors = notAdmin.address;
      const contributorsBefore = await pirexFees.contributors();
      const [setEvent] = await callAndReturnEvents(pirexFees.setFeeRecipient, [
        feeRecipientEnum.contributors,
        newContributors,
      ]);
      const contributorsAfter = await pirexFees.contributors();

      await pirexFees.setFeeRecipient(
        feeRecipientEnum.contributors,
        contributorsBefore
      );

      expect(contributorsBefore).to.equal(contributors.address);
      expect(contributorsBefore).to.not.equal(contributorsAfter);
      expect(contributorsAfter).to.equal(notAdmin.address);
      validateEvent(setEvent, 'SetFeeRecipient(uint8,address)', {
        f: feeRecipientEnum.contributors,
        recipient: notAdmin.address,
      });
      expect(contributorsBefore).to.equal(await pirexFees.contributors());
    });
  });

  describe('setFeePercent', function () {
    it('Should revert if percents sum is not 100', async function () {
      const invalidPercents = {
        treasury: 1,
        contributors: 100,
      };

      await expect(
        pirexFees.setFeePercents(
          invalidPercents.treasury,
          invalidPercents.contributors
        )
      ).to.be.revertedWith('InvalidFeePercent()');
    });

    it('Should revert if not called by admin', async function () {
      const percents = {
        treasury: 50,
        contributors: 50,
      };

      await expect(
        pirexFees
          .connect(notAdmin)
          .setFeePercents(percents.treasury, percents.contributors)
      ).to.be.revertedWith(
        `AccessControl: account ${notAdmin.address.toLowerCase()} is missing role ${adminRole}`
      );
    });

    it('Should revert if not called by admin', async function () {
      const percents = {
        treasury: 50,
        contributors: 50,
      };
      const percentsBefore = {
        treasury: await pirexFees.treasuryPercent(),
        contributors: await pirexFees.contributorsPercent(),
      };
      const [setEvent] = await callAndReturnEvents(pirexFees.setFeePercents, [
        percents.treasury,
        percents.contributors,
      ]);
      const percentsAfter = {
        treasury: await pirexFees.treasuryPercent(),
        contributors: await pirexFees.contributorsPercent(),
      };

      expect(percents).to.not.deep.equal(percentsBefore);
      expect(percents).to.deep.equal(percentsAfter);
      validateEvent(setEvent, 'SetFeePercents(uint8,uint8)', {
        _treasuryPercent: percents.treasury,
        _contributorsPercent: percents.contributors,
      });
    });
  });

  describe('distributeFees', function () {
    it('Should revert if called by non distributor', async function () {
      const rewardAddress = admin.address;
      const amount = 1;

      await expect(
        pirexFees.distributeFees(admin.address, rewardAddress, amount)
      ).to.be.revertedWith(
        `AccessControl: account ${admin.address.toLowerCase()} is missing role ${feeDistributorRole}`
      );
    });
  });
});